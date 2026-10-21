import { MikroORM } from '@mikro-orm/core';
import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { JOBS, STORAGE } from './tokens.ts';

/** What the readiness check needs from the job queue and the song storage (the database is MikroORM's). */
export interface ReadinessDeps {
  jobs: { ping(): Promise<unknown> };
  storage: { check?(): Promise<unknown> | unknown };
}

@Controller()
export class HealthController {
  constructor(
    private readonly orm: MikroORM,
    @Inject(JOBS) private readonly jobs: ReadinessDeps['jobs'],
    @Inject(STORAGE) private readonly storage: ReadinessDeps['storage'],
  ) {}

  /** Alive: the process answers. */
  @Get('healthz')
  health() {
    return { ok: true };
  }

  /** Ready: it can talk to Redis, open the database and write to the storage. Each check shows in the body. */
  @Get('readyz')
  async ready(@Res({ passthrough: true }) reply: FastifyReply) {
    const attempt = async (check: () => unknown) => {
      try {
        return Boolean(await check());
      } catch {
        return false;
      }
    };
    const checks = {
      redis: await attempt(() => this.jobs.ping()),
      db: await attempt(async () => (await this.orm.em.getConnection().execute<{ ok: number }>('SELECT 1 AS ok', [], 'get')).ok === 1),
      storage: await attempt(() => (this.storage.check ? this.storage.check() : true)),
    };
    const ok = Object.values(checks).every(Boolean);
    reply.code(ok ? 200 : 503);
    return { ok, checks };
  }
}
