import { Inject, Injectable } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
import type { JobStore } from '../app.ts';
import type { LocalStorage } from '../storage.js';
import { JOBS, STORAGE } from '../tokens.ts';
import { cleanCache, GB, ormCacheUsage } from './cache-cleaner.ts';

interface Logger {
  info(data: Record<string, unknown>, message: string): void;
  error(data: Record<string, unknown>, message: string): void;
}

/** The cache cleaning's clock. server.ts starts it (the tests do not), with the limit from CACHE_MAX_GB. */
@Injectable()
export class CacheCleaner {
  constructor(
    private readonly orm: MikroORM,
    @Inject(STORAGE) private readonly storage: LocalStorage,
    @Inject(JOBS) private readonly jobs: JobStore,
  ) {}

  /** Cleans shortly after the API starts and every `everyMs`. Returns the function that stops the clock. */
  start({ maxBytes, log, everyMs = 6 * 60 * 60 * 1000, firstRunMs = 30_000 }: { maxBytes: number; log: Logger; everyMs?: number; firstRunMs?: number }) {
    const run = async () => {
      try {
        const report = await cleanCache({
          storage: this.storage,
          usage: ormCacheUsage(this.orm),
          jobs: this.jobs,
          maxBytes,
          log: (data, message) => log.info(data, message),
        });
        if (report.removed.length) {
          log.info({ before_gb: +(report.total / GB).toFixed(2), after_gb: +(report.after / GB).toFixed(2), removed: report.removed.length }, 'cache cleaning done');
        }
      } catch (err) {
        log.error({ err: (err as Error).message }, 'cache cleaning failed');
      }
    };
    const first = setTimeout(run, firstRunMs);
    const timer = setInterval(run, everyMs);
    first.unref();
    timer.unref();
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }
}
