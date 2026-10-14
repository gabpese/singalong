// Estatísticas da biblioteca neste computador: quantas músicas, quanto espaço ocupam e quanto tempo o preparo levou.
// Lê só os `meta.json` e os tamanhos dos arquivos de cada pasta em `<biblioteca>/cache/<id>/`.
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const TOP = 5;

/** O tempo de preparo de uma música: a soma dos passos que o worker anotou em `timings_s` (null se não anotou). */
export function prepareSeconds(meta) {
  const timings = meta?.timings_s;
  if (!timings || typeof timings !== 'object') return null;
  const total = Object.values(timings).reduce((sum, value) => sum + (Number.isFinite(value) ? value : 0), 0);
  return total > 0 ? Math.round(total * 10) / 10 : null;
}

async function folderBytes(dir) {
  let total = 0;
  for (const name of await readdir(dir)) {
    const info = await stat(join(dir, name)).catch(() => null);
    if (info?.isFile()) total += info.size;
  }
  return total;
}

/**
 * @param {string} libraryDir a pasta da biblioteca (a que tem `cache/`)
 * @returns {Promise<{ songs: number, bytes: number, avg_prepare_s: number | null, biggest: Array<{ title: string | null, artist: string | null, bytes: number }> }>}
 */
export async function libraryStats(libraryDir) {
  const root = join(libraryDir, 'cache');
  let ids = [];
  try {
    ids = await readdir(root);
  } catch {
    return { songs: 0, bytes: 0, avg_prepare_s: null, biggest: [] }; // biblioteca ainda vazia
  }
  const songs = [];
  for (const id of ids) {
    const dir = join(root, id);
    let meta;
    try {
      meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf-8')); // sem meta.json a música não está pronta
    } catch {
      continue;
    }
    songs.push({ title: meta.title ?? null, artist: meta.artist ?? null, bytes: await folderBytes(dir), prepare: prepareSeconds(meta) });
  }
  const timed = songs.filter((song) => song.prepare !== null);
  return {
    songs: songs.length,
    bytes: songs.reduce((sum, song) => sum + song.bytes, 0),
    avg_prepare_s: timed.length ? Math.round((timed.reduce((sum, song) => sum + song.prepare, 0) / timed.length) * 10) / 10 : null,
    biggest: [...songs].sort((a, b) => b.bytes - a.bytes).slice(0, TOP).map(({ title, artist, bytes }) => ({ title, artist, bytes })),
  };
}
