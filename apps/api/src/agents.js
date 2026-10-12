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

/** O identificador de uma música: o do YouTube (11 caracteres) ou o de um arquivo importado ("f-" + 12 hexadecimais). */
export const VIDEO_ID_PATTERN = '^([A-Za-z0-9_-]{11}|f-[0-9a-f]{12})$';
const VIDEO_ID = new RegExp(VIDEO_ID_PATTERN);
export const MAX_LIBRARY_BATCH = 100;
const MAX_META_BYTES = 20_000;

const PRIVATE_IPV4 = /^(127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/;

/**
 * O endereço (http) do servidor local de mídia do agente, que o NAVEGADOR de todos da sala vai abrir. Só vale máquina local
 * (localhost, 127.x) ou rede privada: um agente comprometido não pode apontar os convidados para um site qualquer.
 * Devolve o endereço normalizado (sem barra no fim) ou null (sem servidor local); lança 400 se for inválido.
 */
export function normalizeMediaBase(value) {
  if (value === undefined || value === null || value === '') return null;
  const invalid = () => new HttpError(400, 'invalid_media_base', 'Endereço de mídia inválido: use http://127.0.0.1:porta/… ou um endereço da rede local.');
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw invalid();
  }
  const hostOk = url.hostname === 'localhost' || url.hostname === '[::1]' || PRIVATE_IPV4.test(url.hostname);
  const path = url.pathname.replace(/\/+$/, '');
  if (url.protocol !== 'http:' || !hostOk || url.username || url.password || url.search || url.hash || !/^(\/[A-Za-z0-9_-]{1,64})?$/.test(path)) throw invalid();
  return `${url.protocol}//${url.host}${path}`;
}

/** Valida uma entrada do catálogo enviada pelo agente. */
function checkLibraryEntry(entry) {
  const bad = (message) => new HttpError(400, 'invalid_library_entry', message);
  if (!entry || typeof entry !== 'object' || !VIDEO_ID.test(String(entry.id))) throw bad('Identificador de música inválido.');
  if (!entry.meta || typeof entry.meta !== 'object' || Array.isArray(entry.meta)) throw bad('meta inválido.');
  if (JSON.stringify(entry.meta).length > MAX_META_BYTES) throw bad('meta grande demais.');
  const files = entry.files ?? {};
  if (typeof files !== 'object' || files === null || Array.isArray(files)) throw bad('files inválido.');
  const exports = Array.isArray(files.exports) ? files.exports.filter((p) => Number.isInteger(p) && p >= -6 && p <= 6) : [];
  return {
    videoId: String(entry.id),
    meta: entry.meta,
    // só o que o servidor usa: o instrumental e a letra são obrigatórios; o resto é opcional
    files: { instrumental: files.instrumental === true, lyrics: files.lyrics === true, melody: files.melody === true, backing: files.backing === true, exports },
  };
}

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
  cloudEmails = [], // e-mails (minúsculos) cujos computadores enviam as músicas para a nuvem automaticamente
}) {
  /** Código digitado: ignora maiúsculas e espaços. */
  const normalizeCode = (code) => String(code ?? '').replace(/\s+/g, '').toUpperCase();

  const online = (session) => Boolean(session) && !session.ended_at && now() - session.last_seen <= ONLINE_MS;

  return {
    /** Gera um código de pareamento de uso único (quem chama já provou ser o administrador do servidor). */
    startPairing(email = null) {
      const code = newPairCode();
      db.savePairCode(sha256(code), now() + PAIR_TTL_MS, now(), email);
      return { code, expires_in: PAIR_TTL_MS / 1000 };
    },

    /** Troca o código por um token de dispositivo (mostrado uma única vez). */
    completePairing(code, name) {
      const used = db.consumePairCode(sha256(normalizeCode(code)), now());
      if (!used) {
        throw new HttpError(400, 'invalid_pair_code', 'Código de pareamento inválido ou vencido.');
      }
      const token = newToken();
      const id = newId();
      db.createDevice({ id, name: clean(name, 60) || 'Meu computador', tokenHash: sha256(token), now: now(), email: used.email });
      return { device_id: id, token };
    },

    /** Este computador envia as músicas dele para a nuvem? Só se foi pareado com um e-mail da lista ENABLED_TO_SEND_TO_CLOUD. */
    canUploadToCloud: (device) => Boolean(device?.email) && cloudEmails.includes(String(device.email).toLowerCase()),

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
    async startSession(device, displayName, { resumeId, mediaBase } = {}) {
      const name = clean(displayName, MAX_NAME);
      if (!name) throw new HttpError(400, 'display_name_required', 'Escolha um apelido para a sessão.');
      const media = normalizeMediaBase(mediaBase); // valida antes de mexer em qualquer sessão
      const current = db.activeSessionOf(device.id);
      if (current && resumeId && current.id === resumeId) {
        db.renameSession(current.id, name);
        db.touchSession(current.id, now());
        if (mediaBase !== undefined) db.setSessionMedia(current.id, media);
        return db.getSession(current.id);
      }
      if (current) await this.endSession(current);
      const id = newId();
      db.createSession({ id, deviceId: device.id, displayName: name, now: now() });
      db.setSessionMedia(id, media);
      return db.getSession(id);
    },

    /** O agente mudou de endereço de mídia (reiniciou o servidor local): a sessão passa a apontar para o novo. */
    setMediaBase(session, mediaBase) {
      db.setSessionMedia(session.id, normalizeMediaBase(mediaBase));
    },

    /**
     * O catálogo local da sessão: de quem é (o dispositivo dono) e onde o navegador busca a mídia. null se a sessão não tem
     * servidor local de mídia (a mídia está no armazenamento do servidor).
     */
    libraryOfSession(sessionId) {
      const session = sessionId ? db.getSession(sessionId) : null;
      return session?.media_base ? { deviceId: session.device_id, mediaBase: session.media_base } : null;
    },

    /** Uma música do catálogo do dispositivo: { meta, files } ou null. */
    librarySong(deviceId, videoId) {
      const row = db.getAgentSong(deviceId, videoId);
      return row ? { meta: JSON.parse(row.meta), files: JSON.parse(row.files) } : null;
    },

    /** As músicas do catálogo do dispositivo (os meta.json). */
    libraryList: (deviceId) => db.listAgentSongs(deviceId).map((row) => JSON.parse(row.meta)),

    /** Publica músicas no catálogo do dispositivo (até MAX_LIBRARY_BATCH por vez). */
    publishLibrary(device, entries) {
      if (!Array.isArray(entries) || entries.length > MAX_LIBRARY_BATCH) {
        throw new HttpError(400, 'invalid_library_batch', `Envie até ${MAX_LIBRARY_BATCH} músicas por vez.`);
      }
      db.upsertAgentSongs(device.id, entries.map(checkLibraryEntry), now());
      return entries.length;
    },

    /** Tira uma música do catálogo (o dono apagou o arquivo). */
    unpublish: (device, videoId) => db.deleteAgentSong(device.id, String(videoId)),

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
