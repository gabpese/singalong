// The TV's audio delay: the sound takes time to reach the ears (speaker, Bluetooth, HDMI) and the microphone takes time to
// deliver what it picked up. Two numbers, kept on this device (the TV):
//   output = how long after the engine plays it the sound is heard -> the lyrics show what is HEARD now (song time - output);
//   input  = how long after it is sung the microphone delivers the sound -> scoring compares the note with the melody at
//            (time - output - input).

export const MAX_LATENCY_MS = 800;
const KEY = 'latency';

export interface Latency {
  output: number;
  input: number;
}

/** An integer from 0 to 800 ms; invalid = 0. */
export function clampLatency(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(n, 0), MAX_LATENCY_MS);
}

export function loadLatency(): Latency {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return { output: clampLatency(saved.output), input: clampLatency(saved.input) };
  } catch {
    return { output: 0, input: 0 }; // no storage (or outside a browser)
  }
}

export function saveLatency({ output, input }: Latency): Latency {
  const value = { output: clampLatency(output), input: clampLatency(input) };
  try {
    localStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    // no storage: it only lasts until a reload
  }
  return value;
}

/** The song's position (s) that the person hears now, given the one the engine is playing. */
export const heardPosition = (position: number, outputMs: number): number => Math.max(0, position - clampLatency(outputMs) / 1000);

/** The song's position (s) that the microphone is delivering now (what was sung `output + input` ms ago). */
export const sungPosition = (position: number, { output, input }: Latency): number =>
  Math.max(0, position - (clampLatency(output) + clampLatency(input)) / 1000);

/**
 * Instants (s) when the sound "bursts" in a recording: the first point where the volume goes above `threshold` times the
 * highest peak, with at least `minGapMs` between two of them (the echo of the same click does not count twice).
 */
export function detectOnsets(
  samples: ArrayLike<number>,
  sampleRate: number,
  { threshold = 0.35, minGapMs = 300, minPeak = 0.02 }: { threshold?: number; minGapMs?: number; minPeak?: number } = {},
): number[] {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  if (peak < minPeak) return []; // nothing was heard
  const limit = peak * threshold;
  const gap = Math.round((minGapMs / 1000) * sampleRate);
  const onsets: number[] = [];
  let blockedUntil = 0;
  for (let i = 0; i < samples.length; i++) {
    if (i < blockedUntil || Math.abs(samples[i]) < limit) continue;
    onsets.push(i / sampleRate);
    blockedUntil = i + gap;
  }
  return onsets;
}

/**
 * The delay (ms) between the clicks played (`clickTimes`, s) and the ones heard on the microphone (`onsets`, s): the median,
 * over the clicks, of the distance to the first sound that arrived after it (up to `maxMs`). null if fewer than 3 clicks were heard.
 */
export function estimateDelay(
  clickTimes: readonly number[],
  onsets: readonly number[],
  { maxMs = MAX_LATENCY_MS, minHits = 3 }: { maxMs?: number; minHits?: number } = {},
): number | null {
  const delays: number[] = [];
  for (const click of clickTimes) {
    const heard = onsets.find((onset) => onset >= click - 0.01 && onset <= click + maxMs / 1000);
    if (heard !== undefined) delays.push((heard - click) * 1000);
  }
  if (delays.length < minHits) return null;
  delays.sort((a, b) => a - b);
  return Math.round(delays[delays.length >> 1]);
}

/**
 * Splits the measured delay (round trip: output + input) into the two numbers: `outputMs` is what the browser reports for the
 * output (or what the person already adjusted); the rest belongs to the input.
 */
export function splitRoundTrip(roundTripMs: number, outputMs: number): Latency {
  const output = Math.min(clampLatency(outputMs), clampLatency(roundTripMs));
  return { output, input: clampLatency(roundTripMs) - output };
}
