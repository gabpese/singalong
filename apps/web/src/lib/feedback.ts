// Feedback (the howl) detector: when the speaker's sound comes back into the microphone and feeds itself, a narrow peak of a
// single tone shows up in the spectrum, stays on the same frequency and GROWS. A sung voice also holds a note, but it has
// harmonics and wavers; the howl is a pure tone that keeps rising. On detection, the guard halves the voice's volume (and again,
// if it continues) and then brings it back slowly, without going past the point where the howl appeared.
//
// It works on the spectrum in dB (what the AnalyserNode delivers), frame by frame, and knows nothing about Web Audio: it can be
// tested in Node.

export interface FeedbackConfig {
  minHz: number;
  maxHz: number;
  minLevelDb: number;
  prominenceDb: number;
  sidesDb: number;
  harmonicsDb: number;
  persistMs: number;
  growthDb: number;
  loudPersistMs: number;
  loudProminenceDb: number;
  cut: number;
  minFactor: number;
  recoverAfterMs: number;
  recoverPerSecond: number;
  ceilingMargin: number;
  ceilingForgetMs: number;
}

export const FEEDBACK: FeedbackConfig = {
  minHz: 200, // below this there is handling noise; above maxHz, almost no voice
  maxHz: 8000,
  minLevelDb: -50, // a peak weaker than this is not a howl
  prominenceDb: 25, // how far the peak stands above the spectrum's median
  sidesDb: 12, // how far below the peak the neighbours (±3 bins) are: a narrow tone
  harmonicsDb: 10, // 2nd and 3rd harmonics at least this far below the peak (a voice has strong harmonics; the howl is almost pure)
  persistMs: 300, // the peak stays on the same frequency for at least this long...
  growthDb: 4, // ...and grows at least this much
  loudPersistMs: 800, // or it stays nearly fixed, very loud, for longer
  loudProminenceDb: 35,
  cut: 0.5, // each detection halves the gain
  minFactor: 0.05,
  recoverAfterMs: 3000, // with no howl for this long, the volume comes back
  recoverPerSecond: 0.15, // 15 % per second
  ceilingMargin: 0.8, // it comes back to at most 80 % of the gain at which the howl appeared
  ceilingForgetMs: 60_000, // after a minute without a howl, the ceiling is forgotten
};

export interface TonalPeak {
  bin: number;
  level: number;
  prominence: number;
}

export interface FeedbackResult {
  factor: number;
  triggered: boolean;
  hz: number | null;
}

export interface FeedbackGuard {
  update(spectrumDb: Float32Array | number[], nowMs: number, sampleRate: number): FeedbackResult;
  readonly factor: number;
  reset(): void;
}

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
};

/** The peak of a single tone, if there is one. */
export function findTonalPeak(spectrumDb: Float32Array | number[], sampleRate: number, config: FeedbackConfig = FEEDBACK): TonalPeak | null {
  const binHz = sampleRate / (spectrumDb.length * 2);
  const lo = Math.max(4, Math.ceil(config.minHz / binHz));
  const hi = Math.min(spectrumDb.length - 5, Math.floor(config.maxHz / binHz));
  if (hi <= lo) return null;
  let peak = lo;
  for (let i = lo; i <= hi; i++) if (spectrumDb[i] > spectrumDb[peak]) peak = i;
  const level = spectrumDb[peak];
  if (!(level > config.minLevelDb)) return null;
  const prominence = level - median(Array.from(spectrumDb.slice(lo, hi + 1)));
  if (prominence < config.prominenceDb) return null;
  // narrow: the neighbours 3 bins away on both sides are well below
  if (spectrumDb[peak - 3] > level - config.sidesDb || spectrumDb[peak + 3] > level - config.sidesDb) return null;
  // almost pure: the harmonics (when they fit in the spectrum) are well below
  for (const k of [2, 3]) {
    const harmonic = peak * k;
    if (harmonic + 1 >= spectrumDb.length) continue;
    const around = Math.max(spectrumDb[harmonic - 1], spectrumDb[harmonic], spectrumDb[harmonic + 1]);
    if (around > level - config.harmonicsDb) return null;
  }
  return { bin: peak, level, prominence };
}

/** The guard: takes one spectrum per frame and returns the factor (0..1) that multiplies the voice's volume. */
export function createFeedbackGuard(config: FeedbackConfig = FEEDBACK): FeedbackGuard {
  let factor = 1;
  let ceiling = 1;
  let ceilingAt = -Infinity;
  let history: ({ t: number } & TonalPeak)[] = []; // the same peak over time
  let lastTrigger = -Infinity;
  let lastUpdate: number | null = null;

  return {
    update(spectrumDb, nowMs, sampleRate) {
      const dt = lastUpdate === null ? 0 : Math.max(0, nowMs - lastUpdate) / 1000;
      lastUpdate = nowMs;
      const peak = findTonalPeak(spectrumDb, sampleRate, config);
      let triggered = false;
      let hz: number | null = null;

      if (peak) {
        const last = history[history.length - 1];
        if (!last || Math.abs(peak.bin - last.bin) <= 1) history.push({ t: nowMs, bin: peak.bin, level: peak.level, prominence: peak.prominence });
        else history = [{ t: nowMs, bin: peak.bin, level: peak.level, prominence: peak.prominence }];
        const first = history[0];
        const span = nowMs - first.t;
        const growth = peak.level - first.level;
        const growing = span >= config.persistMs && growth >= config.growthDb;
        const loudAndFixed = span >= config.loudPersistMs && peak.prominence >= config.loudProminenceDb && growth >= -1;
        if (growing || loudAndFixed) {
          triggered = true;
          hz = Math.round((peak.bin * sampleRate) / (spectrumDb.length * 2));
          ceiling = Math.max(config.minFactor, factor * config.ceilingMargin);
          ceilingAt = nowMs;
          factor = Math.max(config.minFactor, factor * config.cut);
          lastTrigger = nowMs;
          history = [];
        }
      } else {
        history = [];
      }

      if (nowMs - ceilingAt > config.ceilingForgetMs) ceiling = 1;
      if (!triggered && factor < ceiling && nowMs - lastTrigger >= config.recoverAfterMs) {
        factor = Math.min(ceiling, factor * (1 + config.recoverPerSecond * dt));
      }
      return { factor, triggered, hz };
    },
    get factor() {
      return factor;
    },
    reset() {
      factor = 1;
      ceiling = 1;
      history = [];
      lastTrigger = -Infinity;
      lastUpdate = null;
    },
  };
}
