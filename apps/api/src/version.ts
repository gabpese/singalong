// The installed app's version against the published one: the server says which is the latest, the minimum it still accepts and
// what changed.
import type { UpdateStatus } from './protocol.ts';

/** The published version, as the admin page or the APP_* variables set it (empty = not set). */
export interface PublishedVersion {
  latest?: string;
  minimum?: string;
  notes?: string;
  url?: string;
}

/** "1.2.3" or "1.2.3-beta" → [1, 2, 3]; null when it is not a version. The suffix after "-" is ignored in comparisons. */
export function parseVersion(value: unknown): [number, number, number] | null {
  const match = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:[-+][0-9A-Za-z.-]{0,40})?$/.exec(String(value ?? '').trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** <0 when a < b, 0 when equal, >0 when a > b; null when either is not a version. */
export function compareVersions(a: unknown, b: unknown): number | null {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/**
 * What the installed app needs to know. `status`: "ok" (up to date), "update_available" (a newer version exists),
 * "update_required" (below the minimum: the server refuses it work) or "unknown" (an unknown version, or nothing set).
 */
export function updateInfo(current: unknown, { latest = '', minimum = '', notes = '', url = '' }: PublishedVersion = {}) {
  const info = { latest: parseVersion(latest) ? latest : null, minimum: parseVersion(minimum) ? minimum : null, notes: notes || null, url: url || null };
  let status: UpdateStatus = 'unknown';
  if (parseVersion(current) && (info.latest || info.minimum)) {
    status = 'ok';
    if (info.latest && compareVersions(current, info.latest)! < 0) status = 'update_available';
    if (info.minimum && compareVersions(current, info.minimum)! < 0) status = 'update_required';
  }
  return { current: parseVersion(current) ? (current as string) : null, status, ...info };
}
