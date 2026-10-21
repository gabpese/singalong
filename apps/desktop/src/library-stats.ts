// The Jukebox's statistics on this computer: how many songs, how much space they take and how long their preparation took.
// It reads only each `<library>/cache/<id>/` folder's `meta.json` and its files' sizes.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { LibraryStats } from '../ui/bridge.ts';

const TOP = 5;

/** A song's preparation time: the sum of the steps the worker recorded in `timings_s` (null when it recorded none). */
export function prepareSeconds(meta: { timings_s?: unknown } | null | undefined): number | null {
  const timings = meta?.timings_s;
  if (!timings || typeof timings !== 'object') return null;
  const total = Object.values(timings).reduce((sum: number, value) => sum + (Number.isFinite(value) ? (value as number) : 0), 0);
  return total > 0 ? Math.round(total * 10) / 10 : null;
}

async function folderBytes(dir: string): Promise<number> {
  let total = 0;
  for (const name of await readdir(dir)) {
    const info = await stat(join(dir, name)).catch(() => null);
    if (info?.isFile()) total += info.size;
  }
  return total;
}

/** The statistics of the library in `libraryDir` (the folder that has `cache/`). */
export async function libraryStats(libraryDir: string): Promise<LibraryStats> {
  const root = join(libraryDir, 'cache');
  let ids: string[] = [];
  try {
    ids = await readdir(root);
  } catch {
    return { songs: 0, bytes: 0, avg_prepare_s: null, biggest: [] }; // the library is still empty
  }
  const songs: { title: string | null; artist: string | null; bytes: number; prepare: number | null }[] = [];
  for (const id of ids) {
    const dir = join(root, id);
    let meta;
    try {
      meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf-8')); // without meta.json the song is not ready
    } catch {
      continue;
    }
    songs.push({ title: meta.title ?? null, artist: meta.artist ?? null, bytes: await folderBytes(dir), prepare: prepareSeconds(meta) });
  }
  const timed = songs.filter((song) => song.prepare !== null);
  return {
    songs: songs.length,
    bytes: songs.reduce((sum, song) => sum + song.bytes, 0),
    avg_prepare_s: timed.length ? Math.round((timed.reduce((sum, song) => sum + song.prepare!, 0) / timed.length) * 10) / 10 : null,
    biggest: [...songs].sort((a, b) => b.bytes - a.bytes).slice(0, TOP).map(({ title, artist, bytes }) => ({ title, artist, bytes })),
  };
}
