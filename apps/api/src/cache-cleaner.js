// Limpeza do cache de músicas por uso (LRU): quando a pasta passa do limite, apaga as músicas que ninguém toca há mais tempo.
//
// Cada música ocupa de 5 a 20 MB (instrumental + voz + letra). Sem limpeza o disco enche; com ela, o que é cantado
// com frequência fica e o que foi cantado uma vez há meses sai (e é reprocessado se alguém pedir de novo).

export const GB = 1024 ** 3;

/**
 * @param maxBytes   limite do cache (0 = limpeza desligada)
 * @param targetRatio  depois de passar do limite, apaga até chegar a este tanto dele (evita limpar a cada música nova)
 * @returns {total, after, removed: [{id, bytes, lastUsed}], skipped?}
 */
export async function cleanCache({ storage, db, jobs, maxBytes, now = Date.now, targetRatio = 0.9, log = () => {} }) {
  if (!maxBytes) return { skipped: 'disabled', total: 0, after: 0, removed: [] };

  // tamanho e "último uso" por música
  const songs = new Map();
  for (const file of await storage.listDetailed('cache')) {
    const id = file.key.split('/')[1];
    if (!id) continue;
    const song = songs.get(id) ?? { bytes: 0, newestFile: 0 };
    song.bytes += file.size;
    song.newestFile = Math.max(song.newestFile, file.mtimeMs);
    songs.set(id, song);
  }
  const total = [...songs.values()].reduce((sum, s) => sum + s.bytes, 0);
  if (total <= maxBytes) return { total, after: total, removed: [] };

  // candidatas: fora de qualquer fila e sem processamento em andamento; mais antigas primeiro.
  // "Último uso" = a última vez que tocou ou, se nunca tocou, a data do arquivo mais novo (quando foi processada).
  const inUse = db.activeVideoIds();
  const candidates = [];
  for (const [id, song] of songs) {
    if (inUse.has(id)) continue;
    const job = await jobs.get(id);
    if (job && ['pending', 'processing'].includes(job.status)) continue;
    candidates.push({ id, bytes: song.bytes, lastUsed: Math.max(db.lastPlayed(id) ?? 0, song.newestFile) });
  }
  candidates.sort((a, b) => a.lastUsed - b.lastUsed);

  const target = maxBytes * targetRatio;
  let after = total;
  const removed = [];
  for (const candidate of candidates) {
    if (after <= target) break;
    if (db.activeVideoIds().has(candidate.id)) continue; // entrou numa fila durante a limpeza: fica
    await storage.delete(`cache/${candidate.id}`);
    after -= candidate.bytes;
    removed.push(candidate);
    log({ id: candidate.id, bytes: candidate.bytes, lastUsed: new Date(candidate.lastUsed).toISOString() }, 'música removida do cache');
  }
  return { total, after, removed };
}

/** Roda a limpeza pouco depois de subir e a cada `everyMs`. Devolve a função que para o relógio. */
export function startCacheMaintenance({ storage, db, jobs, maxBytes, log, everyMs = 6 * 60 * 60 * 1000, firstRunMs = 30_000 }) {
  const run = async () => {
    try {
      const report = await cleanCache({ storage, db, jobs, maxBytes, log: (data, msg) => log.info(data, msg) });
      if (report.removed.length) {
        log.info({ before_gb: +(report.total / GB).toFixed(2), after_gb: +(report.after / GB).toFixed(2), removed: report.removed.length }, 'limpeza do cache concluída');
      }
    } catch (err) {
      log.error({ err: err.message }, 'limpeza do cache falhou');
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
