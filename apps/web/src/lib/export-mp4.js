// Exportar a música como MP4 de karaokê (instrumental + letra) para usar offline.

export const EXPORT_PITCHES = [-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6];

/** Nome do arquivo baixado: "Artista - Título (+2).mp4", sem caracteres que os sistemas de arquivos não aceitam. */
export function exportFileName(song, pitch = 0) {
  const base = [song.artist, song.title ?? song.video_id].filter(Boolean).join(' - ');
  const clean = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || song.video_id;
  return `${clean}${pitch ? ` (${pitch > 0 ? '+' : ''}${pitch})` : ''}.mp4`;
}

/**
 * Pede o MP4 e espera ficar pronto. `onWaiting()` é chamado a cada consulta enquanto o worker trabalha.
 * Devolve a URL do arquivo; lança Error com a mensagem para mostrar à pessoa.
 * @param {(method: string, path: string, body?: unknown) => Promise<any>} api
 * @param {string} videoId
 * @param {number} pitch
 * @param {{ onWaiting?: (status: string) => void, sleep?: (ms: number) => Promise<unknown>, intervalMs?: number, timeoutMs?: number }} [options]
 * @returns {Promise<string>}
 */
export async function requestExport(api, videoId, pitch, { onWaiting, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), intervalMs = 2000, timeoutMs = 600_000 } = {}) {
  let info = await api('POST', `/api/songs/${videoId}/export`, { pitch });
  const deadline = Date.now() + timeoutMs;
  while (info.status === 'pending' || info.status === 'processing') {
    if (Date.now() > deadline) throw new Error('A geração do vídeo está demorando demais. Tente de novo mais tarde.');
    onWaiting?.(info.status);
    await sleep(intervalMs);
    info = await api('GET', `/api/songs/${videoId}/export?pitch=${pitch}`);
  }
  if (info.status !== 'ready' || !info.url) throw new Error(info.error ? `Não consegui gerar o vídeo: ${info.error}` : 'Não consegui gerar o vídeo.');
  return info.url;
}

/** Inicia o download no navegador (o arquivo é da mesma origem, então `download` vale). */
export function downloadFile(url, fileName) {
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
}
