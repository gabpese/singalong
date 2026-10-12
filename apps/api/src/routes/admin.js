// Página e API do administrador (só o dono do servidor): e-mails autorizados, computadores pareados e músicas da nuvem.
// O endereço é secreto (ADMIN_PATH) e tudo exige o ADMIN_TOKEN no cabeçalho `X-Admin-Token`. A página é estática e não traz o token: quem a abre digita o
// segredo, que fica só na aba do navegador (sessionStorage). Sem cookies, então não há CSRF; as tentativas erradas são limitadas.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VIDEO_ID_PATTERN, safeEqual } from '../agents.js';
import { HttpError } from '../rooms.js';
import { rateLimited } from '../rate-limit.js';

const here = dirname(fileURLToPath(import.meta.url));
const ASSETS = { '/': ['index.html', 'text/html; charset=utf-8'], '/admin.js': ['admin.js', 'text/javascript; charset=utf-8'], '/admin.css': ['admin.css', 'text/css; charset=utf-8'] };
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
// a página só carrega o que é dela e não conversa com mais ninguém
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export async function adminRoutes(app, { agents, db, storage, config, limiters, now = Date.now }) {
  // Sem o token E sem o endereço secreto (ADMIN_PATH) a administração não existe: nenhuma rota é registrada (tudo é 404).
  if (!config.adminToken || !/^[A-Za-z0-9_-]{16,64}$/.test(config.adminPath ?? '')) return; // (o config.js já filtra; aqui também, por garantia)
  const base = `/${config.adminPath}`;

  // --- a página (o endereço termina em "/", para os arquivos ao lado carregarem por caminho relativo) ---
  app.get(base, async (request, reply) => reply.redirect(`${base}/`));
  for (const [path, [file, type]] of Object.entries(ASSETS)) {
    app.get(`${base}${path}`, async (request, reply) => {
      const body = await readFile(join(here, '..', 'admin', file));
      return reply.header('content-type', type).header('content-security-policy', CSP).header('x-frame-options', 'DENY').header('cache-control', 'no-store').header('x-robots-tag', 'noindex').send(body);
    });
  }

  // --- a API ---
  app.register(async (api) => {
    api.addHook('preHandler', rateLimited(limiters.admin));
    api.addHook('preHandler', async (request) => {
      if (!safeEqual(request.headers['x-admin-token'], config.adminToken)) {
        // errar o segredo gasta uma cota pequena por IP: depois dela, 429 (protege contra adivinhação do token)
        const attempt = limiters.adminFail.hit(`bad|${request.ip}`);
        if (!attempt.ok) throw new HttpError(429, 'rate_limited', 'Muitas tentativas erradas. Espere alguns minutos.');
        throw new HttpError(403, 'forbidden', 'Token de administrador inválido.');
      }
    });

    api.get('/state', async () => {
      const blocked = new Set(db.listBlockedSongs().map((row) => row.video_id));
      const files = await storage.listDetailed('cache');
      const songs = new Map();
      for (const { key, size, mtimeMs: modified } of files) {
        const [, id, name] = key.split('/');
        if (!id || !name) continue;
        const entry = songs.get(id) ?? { id, size: 0, ready: new Set(), updated: 0 };
        entry.size += size;
        entry.updated = Math.max(entry.updated, modified);
        entry.ready.add(name);
        songs.set(id, entry);
      }
      const cloud = [];
      for (const entry of songs.values()) {
        if (!['instrumental.mp3', 'lyrics.json', 'meta.json'].every((n) => entry.ready.has(n))) continue;
        let meta = {};
        try {
          meta = JSON.parse((await storage.read(`cache/${entry.id}/meta.json`)).toString('utf8'));
        } catch {
          /* meta ilegível: aparece só com o id */
        }
        cloud.push({ id: entry.id, title: meta.title ?? null, artist: meta.artist ?? null, size: entry.size, updated: entry.updated, origin: meta.origin ?? 'youtube' });
      }
      cloud.sort((a, b) => b.updated - a.updated);
      return {
        mail: { enabled: Boolean(config.brevoApiKey && config.mailFrom) },
        emails: {
          rules: db.listEmailRules().map((r) => ({ email: r.email, can_pair: r.can_pair === 1, can_cloud: r.can_cloud === 1 })),
          fixed: { pair: config.pairAllowedEmails ?? [], cloud: config.cloudUploadEmails ?? [] }, // vêm do .env: só se mudam lá
        },
        devices: db.listDevices().map((d) => ({ id: d.id, name: d.name, email: d.email, created_at: d.created_at, last_seen: d.last_seen, revoked: Boolean(d.revoked_at), cloud: agents.canUploadToCloud(d) })),
        cloud,
        cloud_total: cloud.reduce((sum, s) => sum + s.size, 0),
        blocked: db.listBlockedSongs(),
      };
    });

    // cria ou altera as permissões de um e-mail ("*" em pareamento = qualquer e-mail)
    api.put('/emails', {
      schema: { body: { type: 'object', additionalProperties: false, properties: { email: { type: 'string', maxLength: 254 }, can_pair: { type: 'boolean' }, can_cloud: { type: 'boolean' } }, required: ['email', 'can_pair', 'can_cloud'] } },
    }, async (request) => {
      const email = request.body.email.trim().toLowerCase();
      if (email !== '*' && !EMAIL.test(email)) throw new HttpError(400, 'bad_email', 'Digite um e-mail válido (ou * para qualquer e-mail).');
      if (email === '*' && request.body.can_cloud) throw new HttpError(400, 'bad_rule', 'O asterisco só vale para receber o código, nunca para enviar músicas.');
      if (!request.body.can_pair && !request.body.can_cloud) {
        db.deleteEmailRule(email); // sem nenhuma permissão a regra não tem o que guardar
        return { ok: true, removed: true };
      }
      db.upsertEmailRule(email, request.body.can_pair, request.body.can_cloud, now());
      return { ok: true };
    });

    api.delete('/emails/:email', async (request) => {
      if (!db.deleteEmailRule(String(request.params.email).trim().toLowerCase())) throw new HttpError(404, 'not_found', 'Este e-mail não está na lista.');
      return { ok: true };
    });

    // desconecta um computador (o app dele precisa parear de novo)
    api.delete('/devices/:id', async (request) => {
      const device = db.getDevice(request.params.id);
      if (!device) throw new HttpError(404, 'not_found', 'Computador não encontrado.');
      await agents.revoke(device);
      return { ok: true };
    });

    // tira uma música da nuvem e a bloqueia: os computadores não a enviam de novo até você liberar
    api.delete('/cloud/:id', { schema: { params: { type: 'object', properties: { id: { type: 'string', pattern: VIDEO_ID_PATTERN } }, required: ['id'] } } }, async (request) => {
      await storage.delete(`cache/${request.params.id}`);
      db.blockSong(request.params.id, now());
      return { ok: true };
    });

    api.post('/cloud/:id/unblock', { schema: { params: { type: 'object', properties: { id: { type: 'string', pattern: VIDEO_ID_PATTERN } }, required: ['id'] } } }, async (request) => {
      if (!db.unblockSong(request.params.id)) throw new HttpError(404, 'not_found', 'Esta música não estava bloqueada.');
      return { ok: true };
    });
  }, { prefix: `${base}/api` });
}
