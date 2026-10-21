import assert from 'node:assert/strict';
import test from 'node:test';
import { createFeedbackGuard, FEEDBACK, findTonalPeak } from '../src/lib/feedback.ts';

type Guard = ReturnType<typeof createFeedbackGuard>;
type Peak = { hz: number; db: number };

const SR = 48000;
const BINS = 1024; // fftSize 2048
const binOf = (hz: number) => Math.round((hz * 2 * BINS) / SR);

/** A spectrum in dB: a noise floor with a fixed ripple, plus the peaks asked for ({ hz, db }), each shaped like a narrow tone. */
function spectrum(peaks: Peak[] = [], floor = -80) {
  const s = new Float32Array(BINS);
  for (let i = 0; i < BINS; i++) s[i] = floor + ((i * 7) % 5) - 2;
  for (const { hz, db } of peaks) {
    const b = binOf(hz);
    s[b] = Math.max(s[b], db);
    for (const [d, drop] of [[1, 12], [2, 26], [3, 45]]) {
      s[b - d] = Math.max(s[b - d], db - drop);
      s[b + d] = Math.max(s[b + d], db - drop);
    }
  }
  return s;
}

/** Runs the guard for `frames` frames of 50 ms; `make(i)` answers each one's spectrum. */
function run(guard: Guard, frames: number, make: (i: number) => Float32Array, start = 0) {
  const results: ReturnType<Guard['update']>[] = [];
  for (let i = 0; i < frames; i++) results.push(guard.update(make(i), start + i * 50, SR));
  return results;
}

test('findTonalPeak: finds a pure tone and ignores noise and a voice with harmonics', () => {
  assert.equal(findTonalPeak(spectrum(), SR), null); // only noise
  const tone = findTonalPeak(spectrum([{ hz: 2400, db: -30 }]), SR);
  assert.ok(tone && Math.abs(tone.bin - binOf(2400)) <= 1 && tone.prominence > 25);
  // a voice: the fundamental with strong 2nd and 3rd harmonics
  const voice = spectrum([{ hz: 440, db: -25 }, { hz: 880, db: -28 }, { hz: 1320, db: -31 }]);
  assert.equal(findTonalPeak(voice, SR), null);
  assert.equal(findTonalPeak(spectrum([{ hz: 2400, db: -60 }]), SR), null); // too weak
  assert.equal(findTonalPeak(spectrum([{ hz: 100, db: -20 }]), SR), null); // below 200 Hz
});

test('a growing pure tone halves the volume; when it goes on, it cuts again', () => {
  const guard = createFeedbackGuard();
  const results = run(guard, 40, (i) => spectrum([{ hz: 2400, db: -40 + i * 0.7 }]));
  const triggers = results.filter((r) => r.triggered);
  assert.ok(triggers.length >= 2, `cuts: ${triggers.length}`);
  assert.equal(triggers[0].factor, 0.5);
  assert.ok(Math.abs((triggers[0].hz ?? 0) - 2400) < 60);
  assert.ok(guard.factor <= 0.25);
});

test('a sustained sung note, with harmonics, never triggers (even getting louder)', () => {
  const guard = createFeedbackGuard();
  const results = run(guard, 100, (i) => spectrum([{ hz: 440, db: -35 + i * 0.1 }, { hz: 880, db: -38 + i * 0.1 }, { hz: 1320, db: -41 + i * 0.1 }]));
  assert.equal(results.some((r) => r.triggered), false);
  assert.equal(guard.factor, 1);
});

test('a tone whose frequency changes every moment (a wide vibrato, a siren) does not trigger', () => {
  const guard = createFeedbackGuard();
  const results = run(guard, 60, (i) => spectrum([{ hz: 1000 + (i % 2) * 400, db: -30 + i * 0.5 }]));
  assert.equal(results.some((r) => r.triggered), false);
});

test('a very loud tone that holds for 0.8 s triggers too, even without growing', () => {
  const guard = createFeedbackGuard();
  const results = run(guard, 25, () => spectrum([{ hz: 3000, db: -20 }]));
  assert.ok(results.some((r) => r.triggered));
});

test('after the howl the volume comes back slowly, never above 80 % of the point where it showed up', () => {
  const guard = createFeedbackGuard();
  run(guard, 20, (i) => spectrum([{ hz: 2400, db: -40 + i * 1.2 }]));
  const cut = guard.factor;
  assert.ok(cut < 1);
  // silence: it waits 3 s and then rises little by little
  const quiet = run(guard, 400, () => spectrum(), 2000); // 20 s
  assert.equal(quiet.some((r) => r.triggered), false);
  assert.ok(guard.factor > cut, 'it rose again');
  assert.ok(guard.factor <= 0.8 + 1e-9, `limit: ${guard.factor}`);
  // a minute without a howl forgets the limit and goes back to normal
  run(guard, 1300, () => spectrum(), 30_000);
  assert.ok(guard.factor > 0.99);
});

test('the factor never falls below the minimum', () => {
  const guard = createFeedbackGuard();
  run(guard, 600, (i) => spectrum([{ hz: 2400, db: -40 + (i % 20) * 1.0 }]));
  assert.ok(guard.factor >= FEEDBACK.minFactor);
});
