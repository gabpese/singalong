import websocket from '@fastify/websocket';
import Fastify from 'fastify';
import { openDb } from './db.js';
import { sendFile } from './files.js';
import { createHub, createRoomService, HttpError } from './rooms.js';
import { roomRoutes } from './routes/rooms.js';
import { songRoutes } from './routes/songs.js';
import { createSongService } from './songs.js';
import { safeJoin } from './storage.js';

/**
 * Monta a aplicação com dependências injetadas (config, storage, jobs) para facilitar os testes.
 * `config.dbPath` ausente = banco em memória. O relógio das salas (`app.rooms.start()`) é ligado só pelo server.js.
 */
export function buildApp({ config, storage, jobs, logger = false }) {
  const app = Fastify({ logger, bodyLimit: 256 * 1024 });

  const db = openDb(config.dbPath ?? ':memory:');
  const songs = createSongService({ storage, jobs });
  const rooms = createRoomService({ db, songs, hub: createHub() });
  app.decorate('rooms', rooms);
  app.addHook('onClose', async () => {
    rooms.stop();
    db.close();
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) return reply.code(error.status).send({ error: error.code, message: error.message });
    return reply.send(error);
  });

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (request, reply) => {
    try {
      if (await jobs.ping()) return { ok: true };
    } catch {
      // cai no 503 abaixo
    }
    return reply.code(503).send({ ok: false, error: 'redis_unavailable' });
  });

  app.register(websocket);
  app.register(songRoutes, { prefix: '/api', songs, jobs });
  app.register(roomRoutes, { prefix: '/api', rooms, config });

  if (storage.local) {
    app.get('/media/*', (request, reply) => {
      const file = storage.absolutePath(request.params['*']);
      return file ? sendFile(request, reply, file) : reply.code(403).send({ error: 'forbidden' });
    });
  }

  // páginas (arquivos estáticos); qualquer outra rota sob /api que não existe cai em 404 JSON
  app.get('/*', (request, reply) => {
    const path = request.params['*'];
    if (path.startsWith('api/')) return reply.code(404).send({ error: 'not_found' });
    const file = safeJoin(config.publicDir, path || 'index.html');
    return file ? sendFile(request, reply, file) : reply.code(403).send({ error: 'forbidden' });
  });

  return app;
}
