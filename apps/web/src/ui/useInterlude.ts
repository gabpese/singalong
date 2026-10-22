// The Intermission's clock: the server says how much was left when it sent the state, and each device counts the rest on its own
// (the devices' clocks do not need to match the server's). A new phase (the Applause, or Taking the stage for another song)
// starts the count over.
import { useEffect, useRef, useState } from 'react';
import type { Interlude } from '../lib/types.ts';

export interface InterludeClock {
  /** How much has passed since the phase began (ms), counting what passed before this device received the state. */
  elapsedMs: number;
  /** How much is left (ms). */
  leftMs: number;
  /** The seconds left, rounded up (the countdown's number). */
  seconds: number;
}

export function useInterlude(interlude: Interlude | null | undefined): InterludeClock | null {
  const started = useRef<{ key: string; at: number } | null>(null);
  const [, setTick] = useState(0);
  const key = interlude ? `${interlude.phase}:${interlude.item_id}` : '';

  if (!interlude) started.current = null;
  else if (started.current?.key !== key) {
    started.current = { key, at: performance.now() - Math.max(0, interlude.total_ms - interlude.left_ms) };
  }

  useEffect(() => {
    if (!key) return undefined;
    const timer = setInterval(() => setTick((n) => n + 1), 250);
    return () => clearInterval(timer);
  }, [key]);

  if (!interlude || !started.current) return null;
  const elapsedMs = Math.min(interlude.total_ms, performance.now() - started.current.at);
  const leftMs = Math.max(0, interlude.total_ms - elapsedMs);
  return { elapsedMs, leftMs, seconds: Math.ceil(leftMs / 1000) };
}
