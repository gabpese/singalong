import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { MikroORM } from '@mikro-orm/core';
import type { AppConfig } from '../app.ts';
import { AppRelease } from '../database/entities.ts';
import type { PublishedRelease, ReleaseFields } from '../protocol.ts';
import { CONFIG } from '../tokens.ts';
import { cleanRelease } from './release.ts';

/**
 * The published app version. Every agent request checks it, so it is read from the database once, when the API starts, and
 * kept in memory; publishing or clearing it on the admin page writes the database and the copy together. Only this process
 * writes it (one API instance serves everyone, ADR 0006): with more than one, the copy would need refreshing.
 */
@Injectable()
export class ReleaseService implements OnModuleInit {
  private published: (ReleaseFields & { updatedAt: number }) | null = null;

  constructor(
    private readonly orm: MikroORM,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  async onModuleInit() {
    const saved = await this.orm.em.fork().findOne(AppRelease, { id: 1 });
    this.published = saved ? { latest: saved.latest, minimum: saved.minimum, notes: saved.notes, url: saved.url, updatedAt: saved.updatedAt } : null;
  }

  /** What applies now. */
  get(): PublishedRelease {
    if (this.published) {
      const { updatedAt, ...fields } = this.published;
      return { ...fields, source: 'panel', updated_at: updatedAt };
    }
    const env = this.env();
    return { ...env, source: Object.values(env).some(Boolean) ? 'env' : 'none', updated_at: null };
  }

  /** What the .env says (the admin page shows what clearing would bring back). */
  env(): ReleaseFields {
    const { appLatestVersion, appMinVersion, appNotes, appDownloadUrl } = this.config;
    return { latest: appLatestVersion ?? '', minimum: appMinVersion ?? '', notes: appNotes ?? '', url: appDownloadUrl ?? '' };
  }

  /** Publishes a version from the admin page; throws a ReleaseError when the page sent something invalid. */
  async set(input: Partial<Record<keyof ReleaseFields, unknown>>): Promise<ReleaseFields> {
    const clean = cleanRelease(input);
    const updatedAt = Date.now();
    await this.orm.em.fork().upsert(AppRelease, { id: 1, ...clean, updatedAt });
    this.published = { ...clean, updatedAt };
    return clean;
  }

  /** The .env applies again. Returns whether a published version was removed. */
  async clear(): Promise<boolean> {
    const removed = await this.orm.em.fork().nativeDelete(AppRelease, { id: 1 });
    this.published = null;
    return removed > 0;
  }
}
