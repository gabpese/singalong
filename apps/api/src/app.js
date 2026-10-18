import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { createAgentService } from './agents.js';
import { createMailer } from './mailer.js';
import { createRelease } from './release.js';
import { openDb } from './db.js';
import { sendFile } from './files.js';
import { DEFAULT_LIMITS, createRateLimiter } from './rate-limit.js';
import { createHub, createRoomService, HttpError } from './rooms.js';
import { adminRoutes } from './routes/admin.js';
import { agentRoutes } from './routes/agent.js';
import { roomRoutes } from './routes/rooms.js';
import { songRoutes } from './routes/songs.js';
import { createSongService } from './songs.js';
import { safeJoin } from './storage.js';

/**
 * Monta a aplicação com dependências injetadas (config, storage, jobs) para facilitar os testes.
 * `config.dbPath` ausente = banco em memória. O relógio das salas (`app.rooms.start()`) é ligado só pelo server.js.
 */
export function buildApp({ config, storage, jobs, logger = false, mailer = createMailer({ apiKey: config.brevoApiKey, fromEmail: config.mailFrom, fromName: config.mailFromName }) }) {
  const app = Fastify({ logger, bodyLimit: 256 * 1024, trustProxy: Boolean(config.trustProxy) });

  const db = openDb(config.dbPath ?? ':memory:');
  // limites de requisições por pessoa (config.rateLimits sobrescreve o padrão; os testes usam isso)
  const limiters = Object.fromEntries(
    Object.entries({ ...DEFAULT_LIMITS, ...(config.rateLimits ?? {}) }).map(([name, options]) => [name, createRateLimiter(options)]),
  );
  const agents = createAgentService({ db, jobs, cloudEmails: config.cloudUploadEmails ?? [] });
  const songs = createSongService({ storage, jobs, agents });
  const rooms = createRoomService({
    db,
    songs,
    hub: createHub(),
    agents,
    // sem durações na configuração (os testes da API) não há intervalo: a próxima música começa na hora, como antes
    intermission: { applauseMs: config.intermissionApplauseMs ?? 0, stageMs: config.intermissionStageMs ?? 0, byDefault: config.intermissionByDefault ?? true },
  });
  app.decorate('rooms', rooms);
  app.decorate('agents', agents);
  app.decorate('db', db);
  const release = createRelease({ config, db });
  app.decorate('release', release);
  app.addHook('onClose', async () => {
    rooms.stop();
    db.close();
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) return reply.code(error.status).send({ error: error.code, message: error.message });
    return reply.send(error);
  });

  app.get('/healthz', async () => ({ ok: true }));
  // pronto = consegue falar com o Redis, abrir o banco e gravar no armazenamento. Cada verificação aparece no corpo.
  app.get('/readyz', async (request, reply) => {
    const attempt = async (fn) => {
      try {
        return Boolean(await fn());
      } catch {
        return false;
      }
    };
    const checks = {
      redis: await attempt(() => jobs.ping()),
      db: await attempt(() => db.ping()),
      storage: await attempt(() => (storage.check ? storage.check() : true)),
    };
    const ok = Object.values(checks).every(Boolean);
    return reply.code(ok ? 200 : 503).send({ ok, checks });
  });

  app.register(websocket);
  app.register(songRoutes, { prefix: '/api', songs, jobs, limiters, rooms, agents });
  app.register(roomRoutes, { prefix: '/api', rooms, config, limiters, release });
  app.register(agentRoutes, { prefix: '/agent/v1', agents, jobs, rooms, config, limiters, mailer, storage, release });

  app.register(adminRoutes, { agents, db, storage, config, limiters, release });

  if (storage.local) {
    app.get('/media/*', (request, reply) => {
      const file = storage.absolutePath(request.params['*']);
      return file ? sendFile(request, reply, file) : reply.code(403).send({ error: 'forbidden' });
    });
  }

  // páginas (arquivos estáticos); qualquer outra rota sob /api que não existe cai em 404 JSON
  app.get('/*', (request, reply) => {
    const path = request.params['*'];
    if (path.startsWith('api/') || path.startsWith('agent/')) return reply.code(404).send({ error: 'not_found' });
    const file = safeJoin(config.publicDir, path || 'index.html');
    return file ? sendFile(request, reply, file) : reply.code(403).send({ error: 'forbidden' });
  });

  return app;
}
