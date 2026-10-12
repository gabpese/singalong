// Agente local: dispositivos pareados, sessões e quem está "online".
//
// O dono instala o app no computador dele (o "agente"), pareia com este servidor por um código de uso único e inicia uma
// SESSÃO. As salas criadas na sessão mandam os pedidos de música para o agente do dono da sessão (e só para ele).
// A nuvem sabe só um apelido de exibição e se o dono está online: nunca cookies, e-mail ou a conta do YouTube.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { HttpError, generateCode } from './rooms.js';

export const PAIR_CODE_LENGTH = 8;
export const PAIR_TTL_MS = 10 * 60 * 1000;
export const ONLINE_MS = 45_000; // sem sinal (heartbeat, claim, progresso) por mais que isso = dono offline
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // sessão sem sinal por 1 dia é encerrada (o app fechou sem avisar)
export const MAX_NAME = 30;

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const clean = (text, max) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** Compara em tempo constante (o token de administrador não pode vazar por diferença de tempo). */
export function safeEqual(a, b) {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}

export function createAgentService({
  db,
  jobs,
  now = Date.now,
  newId = randomUUID,
  newToken = () => `sga_${randomBytes(32).toString('base64url')}`,
  newPairCode = () => generateCode(PAIR_CODE_LENGTH),
}) {
  /** Código digitado: ignora maiúsculas e espaços. */
  const normalizeCode = (code) => String(code ?? '').replace(/\s+/g, '').toUpperCase();

  const online = (session) => Boolean(session) && !session.ended_at && now() - session.last_seen <= ONLINE_MS;

  return {
    /** Gera um código de pareamento de uso único (quem chama já provou ser o administrador do servidor). */
    startPairing() {
      const code = newPairCode();
      db.savePairCode(sha256(code), now() + PAIR_TTL_MS, now());
      return { code, expires_in: PAIR_TTL_MS / 1000 };
    },

    /** Troca o código por um token de dispositivo (mostrado uma única vez). */
    completePairing(code, name) {
      if (!db.consumePairCode(sha256(normalizeCode(code)), now())) {
        throw new HttpError(400, 'invalid_pair_code', 'Código de pareamento inválido ou vencido.');
      }
      const token = newToken();
      const id = newId();
      db.createDevice({ id, name: clean(name, 60) || 'Meu computador', tokenHash: sha256(token), now: now() });
      return { device_id: id, token };
    },

    /** O dispositivo dono do token (ou null se o token não existe ou foi revogado). */
    authenticate(token) {
      const value = String(token ?? '');
      if (!value) return null;
      const device = db.getDeviceByTokenHash(sha256(value));
      if (!device) return null;
      db.touchDevice(device.id, now());
      return device;
    },

    /** Revoga o dispositivo e encerra a sessão dele. */
    async revoke(device) {
      const session = db.activeSessionOf(device.id);
      if (session) await this.endSession(session);
      db.revokeDevice(device.id, now());
    },

    /**
     * Inicia a sessão do dispositivo. `resumeId` retoma a sessão anterior (o app reiniciou): as salas e os pedidos
     * continuam. Sem ele, qualquer sessão ativa do dispositivo é encerrada (e os pedidos pendentes dela, abandonados).
     */
    async startSession(device, displayName, { resumeId } = {}) {
      const name = clean(displayName, MAX_NAME);
      if (!name) throw new HttpError(400, 'display_name_required', 'Escolha um apelido para a sessão.');
      const current = db.activeSessionOf(device.id);
      if (current && resumeId && current.id === resumeId) {
        db.renameSession(current.id, name);
        db.touchSession(current.id, now());
        return db.getSession(current.id);
      }
      if (current) await this.endSession(current);
      const id = newId();
      db.createSession({ id, deviceId: device.id, displayName: name, now: now() });
      return db.getSession(id);
    },

    /** A sessão do dispositivo; 404 se não existe ou é de outro dispositivo (não revela que existe). */
    ownSession(device, sessionId) {
      const session = db.getSession(String(sessionId));
      if (!session || session.device_id !== device.id) {
        throw new HttpError(404, 'session_not_found', 'Sessão não encontrada.');
      }
      return session;
    },

    /** Encerra a sessão: os pedidos que ninguém vai atender viram falha com uma mensagem clara. */
    async endSession(session) {
      if (db.endSession(session.id, now())) await jobs.abandonSession?.(session.id);
    },

    /** Sinal de vida do agente: o dispositivo e a sessão ativa dele ficam "online". */
    touch(device) {
      db.touchDevice(device.id, now());
      const session = db.activeSessionOf(device.id);
      if (session) db.touchSession(session.id, now());
      return session;
    },

    /** A sessão ativa do dispositivo (ou null). */
    activeSession: (device) => db.activeSessionOf(device.id),

    /** O dono da sessão está conectado agora? */
    isOnline: (sessionId) => online(db.getSession(sessionId)),

    /** O que as salas mostram sobre o dono: só o apelido e se está online. */
    ownerOf(sessionId) {
      const session = db.getSession(sessionId);
      return session ? { nickname: session.display_name, online: online(session) } : null;
    },

    /** Encerra as sessões que ficaram sem sinal por muito tempo. Devolve quantas. */
    async sweep() {
      const stale = db.listStaleSessions(now() - SESSION_TTL_MS);
      for (const session of stale) await this.endSession(session);
      return stale.length;
    },
  };
}
