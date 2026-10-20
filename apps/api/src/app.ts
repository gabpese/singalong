import 'reflect-metadata';
import websocket from '@fastify/websocket';
import { MikroORM } from '@mikro-orm/core';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { adminPage } from './admin/admin-page.ts';
import { createAgentService } from './agents.js';
import { AppModule } from './app.module.ts';
import { CacheCleaner } from './cache/cache-cleaner.service.ts';
import type { loadConfig } from './config.js';
import { openDb } from './db.js';
import { sendFile } from './files.js';
import type { createMemoryJobStore, createRedisJobStore } from './jobs.js';
import { createMailer } from './mailer.js';
import { DEFAULT_LIMITS, createRateLimiter } from './rate-limit.js';
import { ReleaseService } from './release/release.service.ts';
import { createHub, createRoomService, HttpError } from './rooms.js';
import { agentRoutes } from './routes/agent.js';
import { roomRoutes } from './routes/rooms.js';
import { SongService } from './songs/song.service.ts';
import { type LocalStorage, safeJoin } from './storage.js';

/** The settings from loadConfig(); the tests pass only the ones they need, plus their own rate limits. */
export type AppConfig = Partial<ReturnType<typeof loadConfig>> & {
  rateLimits?: Record<string, { max: number; windowMs: number }>;
  intermissionByDefault?: boolean;
};

export type JobStore = ReturnType<typeof createMemoryJobStore> | ReturnType<typeof createRedisJobStore>;

export interface BuildOptions {
  config: AppConfig;
  storage: LocalStorage;
  jobs: JobStore;
  logger?: FastifyServerOptions['logger'];
  mailer?: ReturnType<typeof createMailer>;
}

/** What the API adds to the Fastify instance (the server and the tests reach the services through it). */
export interface AppDecorations {
  rooms: ReturnType<typeof createRoomService>;
  agents: ReturnType<typeof createAgentService>;
  db: ReturnType<typeof openDb>;
  release: ReleaseService;
  orm: MikroORM;
  cacheCleaner: CacheCleaner;
}

export type App = FastifyInstance & AppDecorations;

/**
 * Builds the application with its dependencies injected (config, storage, jobs), which keeps the tests simple.
 * No `config.dbPath` = an in-memory database. The Rooms' clock (`app.rooms.start()`) is started only by server.ts.
 *
 * Nest (ADR 0017) runs on this same Fastify instance. The areas that have not moved to it yet stay Fastify plugins, inside a
 * context of their own: Nest installs its error and not-found handlers at the root, and those routes keep theirs.
 */
export async function buildApp({
  config,
  storage,
  jobs,
  logger = false,
  mailer = createMailer({ apiKey: config.brevoApiKey, fromEmail: config.mailFrom, fromName: config.mailFromName }),
}: BuildOptions): Promise<App> {
  const app = Fastify({ logger, bodyLimit: 256 * 1024, trustProxy: Boolean(config.trustProxy) });

  const db = openDb(config.dbPath ?? ':memory:');
  // request limits per person (config.rateLimits overrides the defaults; the tests use it)
  const limiters = Object.fromEntries(
    Object.entries({ ...DEFAULT_LIMITS, ...(config.rateLimits ?? {}) }).map(([name, options]) => [name, createRateLimiter(options)]),
  );
  const agents = createAgentService({ db, jobs, cloudEmails: config.cloudUploadEmails ?? [] });
  const songs = new SongService(storage, jobs, agents);
  const rooms = createRoomService({
    db,
    songs,
    hub: createHub(),
    agents,
    // with no durations in the config (the API tests) there is no Intermission: the next song starts at once, as before
    intermission: { applauseMs: config.intermissionApplauseMs ?? 0, stageMs: config.intermissionStageMs ?? 0, byDefault: config.intermissionByDefault ?? true },
  });

  // Nest takes the root: /healthz, /readyz and the areas that moved (ROADMAP, step 3). The Fastify routes below use its services.
  const nest = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot({ config, db, jobs, storage, agents, limiters, songs, rooms }),
    new FastifyAdapter(app as never),
    {
      logger: false,
      bodyParser: false, // Fastify's own JSON parser (with the body limit above) keeps serving every route
    },
  );
  const release = nest.get(ReleaseService);
  const orm = nest.get(MikroORM);
  app.decorate('rooms', rooms);
  app.decorate('agents', agents);
  app.decorate('db', db);
  app.decorate('release', release);
  app.decorate('orm', orm);
  app.decorate('cacheCleaner', nest.get(CacheCleaner));

  app.register(async (legacy) => {
    legacy.setErrorHandler((error, request, reply) => {
      if (error instanceof HttpError) return reply.code(error.status).send({ error: error.code, message: error.message });
      return reply.send(error);
    });

    legacy.register(websocket);
    legacy.register(roomRoutes, { prefix: '/api', rooms, config, limiters, release });
    legacy.register(agentRoutes, { prefix: '/agent/v1', agents, jobs, rooms, config, limiters, mailer, storage, release });
    legacy.register(adminPage, { config });

    if (storage.local) {
      legacy.get('/media/*', (request, reply) => {
        const file = storage.absolutePath((request.params as Record<string, string>)['*']);
        return file ? sendFile(request, reply, file) : reply.code(403).send({ error: 'forbidden' });
      });
    }

    // the pages (static files); any other route under /api or /agent that does not exist is a JSON 404
    legacy.get('/*', (request, reply) => {
      const path = (request.params as Record<string, string>)['*'];
      if (path.startsWith('api/') || path.startsWith('agent/')) return reply.code(404).send({ error: 'not_found' });
      const file = safeJoin(config.publicDir, path || 'index.html');
      return file ? sendFile(request, reply, file) : reply.code(403).send({ error: 'forbidden' });
    });
  });

  await nest.init();
  // the migrations run before any request: the baseline changes nothing; the ones after it change the schema
  await orm.migrator.up();

  app.addHook('onClose', async () => {
    rooms.stop();
    await orm.close();
    db.close();
  });

  return app as unknown as App;
}
