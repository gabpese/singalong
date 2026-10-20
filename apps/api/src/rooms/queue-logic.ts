// The Queue's pure rules (no I/O), tested on their own.

export const PITCH_MIN = -6;
export const PITCH_MAX = 6;

/** What the order rules need of a Queue item. */
export interface Orderable {
  id: number;
  videoId: string;
  clientId: string;
}

/** The Key in semitones: an integer from -6 to +6 (beyond that the audio degrades). Invalid values become 0. */
export function clampPitch(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(n, PITCH_MIN), PITCH_MAX);
}

/** The backing vocals' level: an integer from 0 to 100 (%). Invalid values become 0 (off). */
export function clampBacking(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(n, 0), 100);
}

/** The original voice's level (the guide): the same range as the backing vocals. */
export const clampGuide = clampBacking;

/**
 * Who sings each line of a Duet: one letter per lyrics line, `a` (the singer who added the song), `b` (the guest), `*` (both)
 * or `-` (nobody: an empty line). Returns the clean text, `null` (back to the automatic split), or throws when it is not a
 * valid split.
 */
export const PARTS_MAX = 3000;
export function cleanParts(value: unknown): string | null {
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > PARTS_MAX || !/^[ab*-]+$/.test(value)) {
    throw new Error('invalid_parts');
  }
  return value;
}

/** The lyrics offset in seconds, within ±10 s and to 2 decimals. */
export function clampOffset(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.min(Math.max(n, -10), 10) * 100) / 100;
}

/**
 * The order of the Fair rotation: one song per person per round, in the order each person joined the Queue. Whoever sang
 * last (`lastClientId`) goes to the end of the first round, if someone else is waiting. Within each person, the Queue's
 * order holds.
 */
export function fairOrder<T extends Orderable>(queued: T[], lastClientId: string | null = null): T[] {
  const byClient = new Map<string, T[]>();
  for (const item of queued) {
    if (!byClient.has(item.clientId)) byClient.set(item.clientId, []);
    byClient.get(item.clientId)!.push(item);
  }
  let clients = [...byClient.keys()];
  if (lastClientId && clients.length > 1 && byClient.has(lastClientId)) {
    clients = [...clients.filter((c) => c !== lastClientId), lastClientId];
  }
  const out: T[] = [];
  while (out.length < queued.length) {
    for (const c of clients) {
      const next = byClient.get(c)!.shift();
      if (next) out.push(next);
    }
  }
  return out;
}

export interface OrderOptions {
  fair?: boolean;
  lastClientId?: string | null;
}

/** The items in the order they will play: the Queue's, or the Fair rotation's when it is on. */
export function playOrder<T extends Orderable>(queued: T[], { fair = false, lastClientId = null }: OrderOptions = {}): T[] {
  return fair ? fairOrder(queued, lastClientId) : queued;
}

/**
 * The next item to play.
 * - `queued`: the items in the Queue's order.
 * - `readyIds`: the video ids whose preparation is done. Items not ready yet are SKIPPED and keep their place.
 * - `fair` (the Fair rotation): follows `fairOrder` (one song per person per round).
 */
export function nextPlayable<T extends Orderable>(queued: T[], readyIds: Set<string>, options: OrderOptions = {}): T | null {
  return playOrder(queued, options).find((item) => readyIds.has(item.videoId)) ?? null;
}

/** The neighbour's id to swap places with when moving `id` up or down (null at the ends). */
export function swapTarget(orderedIds: number[], id: number, direction: 'up' | 'down'): number | null {
  const index = orderedIds.indexOf(id);
  if (index === -1) return null;
  const target = direction === 'up' ? index - 1 : index + 1;
  return orderedIds[target] ?? null;
}
