// Exportar a música como MP4 de karaokê (instrumental + letra) para usar offline.

import { t } from '../i18n/index.js';
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
    if (Date.now() > deadline) throw new Error(t('export.slow'));
    onWaiting?.(info.status);
    await sleep(intervalMs);
    info = await api('GET', `/api/songs/${videoId}/export?pitch=${pitch}`);
  }
  if (info.status !== 'ready' || !info.url) throw new Error(info.error ? t('export.failWith', { error: info.error }) : t('export.fail'));
  return info.url;
}

/**
 * Como baixar o arquivo. Da mesma origem, o atributo `download` vale. De outra (o servidor local de mídia, no computador do
 * dono) o navegador o ignora: o pedido leva `?download=<nome>` e o servidor local responde com `Content-Disposition: attachment`.
 * @param {string} url
 * @param {string} fileName
 * @param {string} pageOrigin
 * @returns {{ href: string, useDownloadAttribute: boolean }}
 */
export function downloadTarget(url, fileName, pageOrigin) {
  const target = new URL(url, pageOrigin);
  if (target.origin === pageOrigin) return { href: url, useDownloadAttribute: true };
  target.searchParams.set('download', fileName);
  return { href: target.href, useDownloadAttribute: false };
}

/** Inicia o download no navegador (do servidor ou, no armazenamento local, do computador do dono). */
export function downloadFile(url, fileName) {
  const { href, useDownloadAttribute } = downloadTarget(url, fileName, location.origin);
  const link = document.createElement('a');
  link.href = href;
  if (useDownloadAttribute) link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
}
