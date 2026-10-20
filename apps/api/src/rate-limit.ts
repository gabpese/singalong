// A limit on requests per person (a fixed window, in memory): it protects the YouTube search (which YouTube may block with a
// captcha when hammered) and the creation of Rooms and requests against abuse, or a button pressed nonstop.
import type { FastifyRequest } from 'fastify';

export interface RateLimiter {
  /** Records a request: { ok: false, retryAfterSec } once over the limit. */
  hit(key: string): { ok: true } | { ok: false; retryAfterSec: number };
  /** How many keys it holds now. */
  readonly size: number;
}

/** `max` requests fit in each window of `windowMs`. */
export function createRateLimiter({ max, windowMs, now = Date.now }: { max: number; windowMs: number; now?: () => number }): RateLimiter {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  let lastSweep = now();

  return {
    hit(key) {
      const t = now();
      if (t - lastSweep > windowMs) {
        for (const [k, b] of buckets) if (b.resetAt <= t) buckets.delete(k); // the map does not grow forever
        lastSweep = t;
      }
      let bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= t) {
        bucket = { count: 0, resetAt: t + windowMs };
        buckets.set(key, bucket);
      }
      bucket.count++;
      return bucket.count <= max ? { ok: true } : { ok: false, retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - t) / 1000)) };
    },
    get size() {
      return buckets.size;
    },
  };
}

/** Who "the person" is: the browser's id; without it, the IP. */
export const keyOf = (request: FastifyRequest) => String(request.headers['x-client-id'] || request.ip);

/** The default limits per person and per minute (config.rateLimits overrides them, e.g. in the tests). */
export const DEFAULT_LIMITS: Record<string, { max: number; windowMs: number }> = {
  search: { max: 12, windowMs: 60_000 }, // each search becomes a query to YouTube
  addToQueue: { max: 30, windowMs: 60_000 },
  createRoom: { max: 10, windowMs: 60_000 },
  admin: { max: 120, windowMs: 60_000 }, // the admin page (per IP)
  adminFail: { max: 8, windowMs: 10 * 60_000 }, // wrong tokens per IP
  pairRequest: { max: 5, windowMs: 10 * 60_000 }, // requests for a code by e-mail, per IP
  pairEmail: { max: 3, windowMs: 60 * 60_000 }, // and per e-mail address (nobody gets flooded with messages)
  pair: { max: 10, windowMs: 60_000 }, // the agent's pairing attempts (the code has 8 characters and lasts 10 min)
};
