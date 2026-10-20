import { MikroORM } from '@mikro-orm/core';
import { type DynamicModule, Global, Module } from '@nestjs/common';
import { AgentService } from './agents/agent.service.ts';
import type { AppConfig, JobStore } from './app.ts';
import type { openDb } from './db.js';
import type { createMailer } from './mailer.ts';
import type { createRateLimiter } from './rate-limit.ts';
import { RoomService } from './rooms/room.service.ts';
import { SongService } from './songs/song.service.ts';
import type { LocalStorage } from './storage.ts';
import { CONFIG, DB, JOBS, LIMITERS, MAILER, STORAGE } from './tokens.ts';

/** The services built before Nest, as app.ts hands them over. */
export interface LegacyServices {
  config: AppConfig;
  db: ReturnType<typeof openDb>;
  orm: MikroORM;
  jobs: JobStore;
  storage: LocalStorage;
  mailer: ReturnType<typeof createMailer>;
  agents: AgentService;
  limiters: Record<string, ReturnType<typeof createRateLimiter>>;
  songs: SongService;
  rooms: RoomService;
}

/**
 * Makes the services built before Nest injectable in every module: by the tokens in tokens.ts, or by their class (MikroORM,
 * the AgentService, the SongService and the RoomService).
 */
@Global()
@Module({})
export class LegacyModule {
  static forRoot(services: LegacyServices): DynamicModule {
    const providers = [
      { provide: CONFIG, useValue: services.config },
      { provide: DB, useValue: services.db },
      { provide: MikroORM, useValue: services.orm },
      { provide: JOBS, useValue: services.jobs },
      { provide: STORAGE, useValue: services.storage },
      { provide: MAILER, useValue: services.mailer },
      { provide: AgentService, useValue: services.agents },
      { provide: LIMITERS, useValue: services.limiters },
      { provide: RoomService, useValue: services.rooms },
      { provide: SongService, useValue: services.songs },
    ];
    return { module: LegacyModule, providers, exports: providers.map((provider) => provider.provide) };
  }
}
