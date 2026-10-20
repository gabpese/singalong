import 'reflect-metadata';
import { MikroORM } from '@mikro-orm/core';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { WsAdapter } from '@nestjs/platform-ws';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { adminPage } from './admin/admin-page.ts';
import { AgentService } from './agents/agent.service.ts';
import { cloudUploads } from './agents/cloud.ts';
import { AppModule } from './app.module.ts';
import { CacheCleaner } from './cache/cache-cleaner.service.ts';
import type { loadConfig } from './config.ts';
import { ormOptions } from './database/orm.ts';
import { openDb } from './db.js';
import { sendFile } from './files.ts';
import { HttpError } from './http-error.ts';
import type { JobStore } from './jobs.ts';
import { createMailer } from './mailer.ts';
import { DEFAULT_LIMITS, createRateLimiter } from './rate-limit.ts';
import { ReleaseService } from './release/release.service.ts';
import { RoomService } from './rooms/room.service.ts';
import { parseRoomMessage } from './rooms/rooms.gateway.ts';
import { SongService } from './songs/song.service.ts';
import { type LocalStorage, safeJoin } from './storage.ts';

/** The settings from loadConfig(); the tests pass only the ones they need, plus their own rate limits. */
export type AppConfig = Partial<ReturnType<typeof loadConfig>> & {
  rateLimits?: Record<string, { max: number; windowMs: number }>;
  intermissionByDefault?: boolean;
};

export type { JobStore };

export interface BuildOptions {
  config: AppConfig;
  storage: LocalStorage;
  jobs: JobStore;
  logger?: FastifyServerOptions['logger'];
  mailer?: ReturnType<typeof createMailer>;
}

/** What the API adds to the Fastify instance (the server and the tests reach the services through it). */
export interface AppDecorations {
  rooms: RoomService;
  agents: AgentService;
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
 * Nest (ADR 0017) runs on this same Fastify instance and serves every API route and the Rooms' WebSocket. A few routes stay
 * Fastify routes, inside a context of their own (Nest installs its error and not-found handlers at the root, and these keep
 * theirs): the cloud upload, with its own body parser and limit; the admin page's files; the media files; and the pages.
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
  // MikroORM shares db.js's connection (ADR 0017). The migrations run before anything reads the database: the baseline
  // changes nothing; the ones after it change the schema
  const orm = await MikroORM.init(ormOptions(db.connection));
  await orm.migrator.up();
  // request limits per person (config.rateLimits overrides the defaults; the tests use it)
  const limiters = Object.fromEntries(
    Object.entries({ ...DEFAULT_LIMITS, ...(config.rateLimits ?? {}) }).map(([name, options]) => [name, createRateLimiter(options)]),
  );
  const agents = new AgentService(orm, jobs, { cloudEmails: config.cloudUploadEmails ?? [] });
  const songs = new SongService(storage, jobs, agents);
  const rooms = new RoomService({
    orm,
    songs,
    agents,
    // with no durations in the config (the API tests) there is no Intermission: the next song starts at once, as before
    intermission: { applauseMs: config.intermissionApplauseMs ?? 0, stageMs: config.intermissionStageMs ?? 0, byDefault: config.intermissionByDefault ?? true },
  });

  // Nest takes the root; the Fastify routes below use the same services
  const nest = await NestFactory.create<NestFastifyApplication>(
    AppModule.forRoot({ config, db, orm, jobs, storage, mailer, agents, limiters, songs, rooms }),
    new FastifyAdapter(app as never),
    {
      logger: false,
      bodyParser: false, // Fastify's own JSON parser (with the body limit above) keeps serving every route
    },
  );
  // the Rooms' WebSocket gateway, with the protocol's own messages ({ type, ... })
  nest.useWebSocketAdapter(new WsAdapter(nest, { messageParser: parseRoomMessage }));
  const release = nest.get(ReleaseService);
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

    legacy.register(cloudUploads, { prefix: '/agent/v1', agents, storage });
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
      const file = safeJoin(config.publicDir!, path || 'index.html');
      return file ? sendFile(request, reply, file) : reply.code(403).send({ error: 'forbidden' });
    });
  });

  await nest.init();

  app.addHook('onClose', async () => {
    rooms.stop();
    await orm.close();
    db.close();
  });

  return app as unknown as App;
}
