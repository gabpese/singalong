// Export the song as a karaoke MP4 (instrumental + lyrics) to use offline.

import { t } from '../i18n/index.ts';

export const EXPORT_PITCHES = [-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6];

interface ExportInfo {
  status: string;
  url?: string;
  error?: string;
}

type Api = (method: string, path: string, body?: unknown) => Promise<ExportInfo>;

/** The downloaded file's name: "Artist - Title (+2).mp4", without characters that file systems refuse. */
export function exportFileName(song: { artist?: string | null; title?: string | null; video_id: string }, pitch = 0): string {
  const base = [song.artist, song.title ?? song.video_id].filter(Boolean).join(' - ');
  const clean = base.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || song.video_id;
  return `${clean}${pitch ? ` (${pitch > 0 ? '+' : ''}${pitch})` : ''}.mp4`;
}

/**
 * Asks for the MP4 and waits until it is ready. `onWaiting()` is called on each check while the worker works.
 * Returns the file's URL; throws an Error with the message to show the person.
 */
export async function requestExport(
  api: Api,
  videoId: string,
  pitch: number,
  {
    onWaiting,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    intervalMs = 2000,
    timeoutMs = 600_000,
  }: { onWaiting?: (status: string) => void; sleep?: (ms: number) => Promise<unknown>; intervalMs?: number; timeoutMs?: number } = {},
): Promise<string> {
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
 * How to download the file. From the same origin, the `download` attribute works. From another one (the local media server, on
 * the owner's computer) the browser ignores it: the request carries `?download=<name>` and the local server answers with
 * `Content-Disposition: attachment`.
 */
export function downloadTarget(url: string, fileName: string, pageOrigin: string): { href: string; useDownloadAttribute: boolean } {
  const target = new URL(url, pageOrigin);
  if (target.origin === pageOrigin) return { href: url, useDownloadAttribute: true };
  target.searchParams.set('download', fileName);
  return { href: target.href, useDownloadAttribute: false };
}

/** Starts the download in the browser (from the server or, with local storage, from the owner's computer). */
export function downloadFile(url: string, fileName: string): void {
  const { href, useDownloadAttribute } = downloadTarget(url, fileName, location.origin);
  const link = document.createElement('a');
  link.href = href;
  if (useDownloadAttribute) link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
}
