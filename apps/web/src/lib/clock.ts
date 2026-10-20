// The Stage's clock (phone): the TV plays the song and reports its position every second; between messages the clock runs on
// its own. Each message arrives with an unknown delay, so the SMALLEST difference between the local clock and the song's over
// the latest messages wins (the one that was delayed least): the error drops to a few tens of milliseconds.

export interface SyncClock {
  /** The TV reported that the song is at `ms` now. */
  position(ms: number): void;
  /** The Room is playing or paused. Pausing freezes where it was; resuming continues from there until the TV's next message. */
  setPlaying(value: boolean): void;
  /** A new song (or the singer left the Stage): forget everything. */
  reset(): void;
  /** The song's position now, in seconds. */
  time(): number;
  readonly playing: boolean;
}

/**
 * @param now         local clock in ms (injectable in tests)
 * @param windowSize  how many recent messages go into the estimate
 * @param jump        difference (s) from which it takes a jump to have happened (the song skipped or resumed from a pause)
 */
export function createSyncClock({
  now = () => performance.now(),
  windowSize = 8,
  jump = 1.5,
}: { now?: () => number; windowSize?: number; jump?: number } = {}): SyncClock {
  let samples: number[] = []; // local instant (s) at which the song would be at second 0, according to each message
  let start: number | null = null; // the best estimate of it
  let frozen = 0; // position (s) while paused
  let playing = false;
  const local = () => now() / 1000;

  return {
    position(ms) {
      const t = Math.max(0, Number(ms) || 0) / 1000;
      const sample = local() - t;
      if (start !== null && Math.abs(sample - start) > jump) samples = []; // a jump: the old samples no longer count
      samples.push(sample);
      if (samples.length > windowSize) samples.shift();
      start = Math.min(...samples);
      frozen = t;
    },

    setPlaying(value) {
      if (Boolean(value) === playing) return;
      if (!value && start !== null) frozen = local() - start;
      if (value) {
        start = local() - frozen;
        samples = [start];
      }
      playing = Boolean(value);
    },

    reset() {
      samples = [];
      start = null;
      frozen = 0;
      playing = false;
    },

    time() {
      if (!playing || start === null) return frozen;
      return Math.max(0, local() - start);
    },

    get playing() {
      return playing;
    },
  };
}
