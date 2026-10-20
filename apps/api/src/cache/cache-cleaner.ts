// Cleaning the song cache by use (LRU): when the folder goes over the limit, it deletes the songs nobody has played for the
// longest time.
//
// Each song takes 5 to 20 MB (instrumental + voice + lyrics). Without cleaning the disk fills up; with it, what is sung often
// stays and what was sung once months ago goes (and is prepared again if someone asks for it).
import type { MikroORM } from '@mikro-orm/core';
import { QueueItem, SongSettings } from '../database/entities.ts';
import type { createMemoryJobStore } from '../jobs.js';
import type { LocalStorage } from '../storage.js';

export const GB = 1024 ** 3;

/** What the cleaning needs to know about how the songs are used. */
export interface CacheUsage {
  /** The songs in some Room's queue (queued or playing): never deleted. */
  activeVideoIds(): Promise<Set<string>>;
  /** The last time the song played, or null if it never did. */
  lastPlayed(videoId: string): Promise<number | null>;
}

/** The songs' use, read from the database. Each question gets its own EntityManager. */
export function ormCacheUsage(orm: MikroORM): CacheUsage {
  return {
    async activeVideoIds() {
      const items = await orm.em.fork().find(QueueItem, { status: { $in: ['queued', 'playing'] } });
      return new Set(items.map((item) => item.videoId));
    },
    async lastPlayed(videoId) {
      return (await orm.em.fork().findOne(SongSettings, { videoId }))?.lastPlayedAt ?? null;
    },
  };
}

export interface CleanReport {
  total: number;
  after: number;
  removed: { id: string; bytes: number; lastUsed: number }[];
  skipped?: 'disabled';
}

type Log = (data: Record<string, unknown>, message: string) => void;

/**
 * @param maxBytes     the cache's limit (0 = cleaning off)
 * @param targetRatio  once over the limit, it deletes down to this share of it (so it does not clean on every new song)
 */
export async function cleanCache({
  storage,
  usage,
  jobs,
  maxBytes,
  targetRatio = 0.9,
  log = () => {},
}: {
  storage: Pick<LocalStorage, 'listDetailed' | 'delete'>;
  usage: CacheUsage;
  jobs: Pick<ReturnType<typeof createMemoryJobStore>, 'get'>;
  maxBytes: number;
  targetRatio?: number;
  log?: Log;
}): Promise<CleanReport> {
  if (!maxBytes) return { skipped: 'disabled', total: 0, after: 0, removed: [] };

  // size and "last use" per song
  const songs = new Map<string, { bytes: number; newestFile: number }>();
  for (const file of await storage.listDetailed('cache')) {
    const id = file.key.split('/')[1];
    if (!id) continue;
    const song = songs.get(id) ?? { bytes: 0, newestFile: 0 };
    song.bytes += file.size;
    song.newestFile = Math.max(song.newestFile, file.mtimeMs);
    songs.set(id, song);
  }
  const total = [...songs.values()].reduce((sum, song) => sum + song.bytes, 0);
  if (total <= maxBytes) return { total, after: total, removed: [] };

  // candidates: in no queue and with no preparation under way; oldest first.
  // "Last use" = the last time it played or, if it never did, the date of the newest file (when it was prepared).
  const inUse = await usage.activeVideoIds();
  const candidates: CleanReport['removed'] = [];
  for (const [id, song] of songs) {
    if (inUse.has(id)) continue;
    const job = await jobs.get(id);
    if (job && ['pending', 'processing'].includes(job.status)) continue;
    candidates.push({ id, bytes: song.bytes, lastUsed: Math.max((await usage.lastPlayed(id)) ?? 0, song.newestFile) });
  }
  candidates.sort((a, b) => a.lastUsed - b.lastUsed);

  const target = maxBytes * targetRatio;
  let after = total;
  const removed: CleanReport['removed'] = [];
  for (const candidate of candidates) {
    if (after <= target) break;
    if ((await usage.activeVideoIds()).has(candidate.id)) continue; // it joined a queue during the cleaning: it stays
    await storage.delete(`cache/${candidate.id}`);
    after -= candidate.bytes;
    removed.push(candidate);
    log({ id: candidate.id, bytes: candidate.bytes, lastUsed: new Date(candidate.lastUsed).toISOString() }, 'song removed from the cache');
  }
  return { total, after, removed };
}
