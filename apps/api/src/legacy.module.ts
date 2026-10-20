import { type DynamicModule, Global, Module } from '@nestjs/common';
import type { createAgentService } from './agents.js';
import type { AppConfig, JobStore } from './app.ts';
import type { openDb } from './db.js';
import type { createRateLimiter } from './rate-limit.js';
import type { LocalStorage } from './storage.js';
import { AGENTS, CONFIG, DB, JOBS, LIMITERS, STORAGE } from './tokens.ts';

/** The services built before Nest, as app.ts hands them over. */
export interface LegacyServices {
  config: AppConfig;
  db: ReturnType<typeof openDb>;
  jobs: JobStore;
  storage: LocalStorage;
  agents: ReturnType<typeof createAgentService>;
  limiters: Record<string, ReturnType<typeof createRateLimiter>>;
}

/** Makes the services built before Nest injectable in every module, by the tokens in tokens.ts. */
@Global()
@Module({})
export class LegacyModule {
  static forRoot(services: LegacyServices): DynamicModule {
    const providers = [
      { provide: CONFIG, useValue: services.config },
      { provide: DB, useValue: services.db },
      { provide: JOBS, useValue: services.jobs },
      { provide: STORAGE, useValue: services.storage },
      { provide: AGENTS, useValue: services.agents },
      { provide: LIMITERS, useValue: services.limiters },
    ];
    return { module: LegacyModule, providers, exports: providers.map((provider) => provider.provide) };
  }
}
