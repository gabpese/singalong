// Songs on the owner's computer (local storage): the TV fetches them from a local media server, and Chrome and Edge ask the
// user for the "Local network access" permission the first time. These pure functions decide what the TV shows (TRD, section 5).

import { t } from '../i18n/index.ts';

interface MediaState {
  queue?: { song?: { media?: { local?: boolean; instrumental?: string } | null } }[];
}

export type AccessStatus = 'idle' | 'checking' | 'ok' | 'blocked';

/**
 * The local media server's address ("http://127.0.0.1:8765/token"), taken from the address of a local song in the queue;
 * null when the Room has no local song.
 */
export function localMediaBase(state: MediaState | null | undefined): string | null {
  const url = state?.queue?.map((item) => item.song?.media).find((media) => media?.local)?.instrumental;
  const match = url ? /^(.*)\/cache\//.exec(url) : null;
  return match ? match[1] : null;
}

/** How long to wait for an answer before taking the access as blocked (the user may be reading the browser's prompt). */
export const PROBE_TIMEOUT_MS = 30_000;
/** After how long pending the TV starts explaining the browser's prompt. */
export const HINT_AFTER_MS = 1_500;

/**
 * What the TV says about access to the local media server.
 * @param elapsedMs how long the check has been pending
 */
export function accessMessage(status: AccessStatus, elapsedMs = 0): string {
  if (status === 'checking' && elapsedMs >= HINT_AFTER_MS) {
    return t('local.ask');
  }
  if (status === 'blocked') {
    return t('local.blocked');
  }
  return '';
}

/** Checks whether the page can reach the local media server (this also triggers the browser's permission prompt). */
export async function probeLocalMedia(
  base: string,
  { fetchImpl = fetch, timeoutMs = PROBE_TIMEOUT_MS }: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${base}/ping`, { cache: 'no-store', signal: controller.signal });
    return response.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
