// Voice noise gate: when nobody sings, the microphone only picks up the room (its noise, the leftover music that echo
// cancellation did not remove) and that comes out of the speakers as "echo" and hiss. The gate lowers the microphone's volume
// in those moments and opens it as soon as the voice comes back. Only the decision (open or close) lives here; the audio
// engine applies the gain.

export interface GateConfig {
  openDb: number;
  closeDb: number;
  holdMs: number;
  floor: number;
  filterHz: number;
}

export const GATE: GateConfig = {
  openDb: -46, // above this (the microphone's RMS volume, in dBFS) a voice came in: the gate opens
  closeDb: -52, // below this the gate starts to close (the gap keeps it from flickering around the threshold)
  holdMs: 280, // after the last voice, wait this long before closing (a pause between words does not cut the phrase)
  floor: 0.12, // a closed gate does not mute completely: it lets a trickle through (a hard cut sounds artificial)
  filterHz: 110, // high-pass filter: removes handling noise and the microphone's rumble
};

/** RMS volume (0..1) in dBFS; total silence is -Infinity. */
export const rmsToDb = (rms: number): number => (rms > 0 ? 20 * Math.log10(rms) : -Infinity);

/** The RMS volume of a block of samples. */
export function blockRms(samples: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

export interface Gate {
  /** The gain for that moment: 1 = open, `floor` = closed. */
  target(rms: number, nowMs: number): number;
  readonly open: boolean;
}

/** One gate per microphone. */
export function createGate(config: Pick<GateConfig, 'openDb' | 'closeDb' | 'holdMs' | 'floor'> = GATE): Gate {
  let open = false;
  let lastLoud = -Infinity;
  return {
    target(rms, nowMs) {
      const db = rmsToDb(rms);
      if (db >= config.openDb) {
        open = true;
        lastLoud = nowMs;
      } else if (open && db >= config.closeDb) {
        lastLoud = nowMs; // there is still a weak voice: keep it open
      } else if (open && nowMs - lastLoud > config.holdMs) {
        open = false;
      }
      return open ? 1 : config.floor;
    },
    get open() {
      return open;
    },
  };
}
