import Fastify from 'fastify';
import { sendFile } from './files.js';
import { safeJoin } from './storage.js';
import { songRoutes } from './routes/songs.js';

/** Monta a aplicação com dependências injetadas (config, storage, jobs) para facilitar os testes. */
export function buildApp({ config, storage, jobs, logger = false }) {
  const app = Fastify({ logger, bodyLimit: 256 * 1024 });

  app.get('/healthz', async () => ({ ok: true }));
  app.get('/readyz', async (request, reply) => {
    try {
      if (await jobs.ping()) return { ok: true };
    } catch {
      // cai no 503 abaixo
    }
    return reply.code(503).send({ ok: false, error: 'redis_unavailable' });
  });

  app.register(songRoutes, { prefix: '/api', storage, jobs });

  if (storage.local) {
    app.get('/media/*', (request, reply) => {
      const file = storage.absolutePath(request.params['*']);
      return file ? sendFile(request, reply, file) : reply.code(403).send({ error: 'forbidden' });
    });
  }

  // player (arquivos estáticos); qualquer outra rota sob /api que não existe cai em 404 JSON
  app.get('/*', (request, reply) => {
    const path = request.params['*'];
    if (path.startsWith('api/')) return reply.code(404).send({ error: 'not_found' });
    const file = safeJoin(config.publicDir, path || 'index.html');
    return file ? sendFile(request, reply, file) : reply.code(403).send({ error: 'forbidden' });
  });

  return app;
}
