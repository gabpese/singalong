// The phones' Reactions (applause, fire...) that float on the TV: only the ones on the list, with a limit per connection so nobody
// floods the screen.

import type { ReactionKind } from '../protocol.ts';

export const REACTION_KINDS: readonly ReactionKind[] = ['clap', 'fire', 'heart', 'party', 'wow'];

export interface Bucket {
  /** Spends one token at `nowMs`; false when there is none left. */
  take(nowMs: number): boolean;
}

/**
 * A token bucket: it starts full (`capacity` Reactions at once) and refills `perSecond` per second. Each Reaction spends a
 * token; without one, the Reaction is dropped silently (pressing nonstop breaks nothing).
 */
export function createBucket({ capacity = 6, perSecond = 3 } = {}): Bucket {
  let tokens = capacity;
  let last: number | null = null;
  return {
    take(nowMs) {
      if (last !== null) tokens = Math.min(capacity, tokens + ((nowMs - last) / 1000) * perSecond);
      last = nowMs;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}
