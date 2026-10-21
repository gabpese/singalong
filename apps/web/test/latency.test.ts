import assert from 'node:assert/strict';
import test from 'node:test';
import { clampLatency, detectOnsets, estimateDelay, heardPosition, MAX_LATENCY_MS, splitRoundTrip, sungPosition } from '../src/lib/latency.ts';

const SR = 48000;

/** A recording of `seconds` with short clicks (a 2 ms sine) at the given instants. */
function recording(seconds: number, clicks: number[], amplitude = 0.5) {
  const samples = new Float32Array(Math.round(seconds * SR));
  for (const at of clicks) {
    const start = Math.round(at * SR);
    for (let i = 0; i < SR * 0.002; i++) samples[start + i] = amplitude * Math.sin((2 * Math.PI * 1800 * i) / SR);
  }
  return samples;
}

test('clampLatency: an integer from 0 to 800; an invalid value becomes 0', () => {
  assert.equal(clampLatency(120.4), 120);
  assert.equal(clampLatency(-5), 0);
  assert.equal(clampLatency(5000), MAX_LATENCY_MS);
  assert.equal(clampLatency('abc'), 0);
  assert.equal(clampLatency(undefined), 0);
});

test('heardPosition and sungPosition: take off the delay and never go negative', () => {
  assert.equal(heardPosition(10, 200), 9.8);
  assert.equal(heardPosition(0.1, 300), 0);
  assert.equal(sungPosition(10, { output: 200, input: 100 }), 9.7);
  assert.equal(sungPosition(0.2, { output: 200, input: 100 }), 0);
});

test('detectOnsets: finds each click only once and ignores the silence', () => {
  const clicks = [0.5, 1.3, 2.1];
  const onsets = detectOnsets(recording(3, clicks), SR);
  assert.equal(onsets.length, 3);
  onsets.forEach((time, i) => assert.ok(Math.abs(time - clicks[i]) < 0.002, `${time} ~ ${clicks[i]}`));
  assert.deepEqual(detectOnsets(new Float32Array(SR), SR), []); // total silence
  assert.deepEqual(detectOnsets(recording(3, clicks, 0.005), SR), []); // almost inaudible: it does not count
});

test('estimateDelay: the median delay between the clicks played and heard', () => {
  const played = [1, 1.8, 2.6, 3.4, 4.2, 5];
  const heard = detectOnsets(recording(7, played.map((time) => time + 0.18)), SR);
  assert.equal(estimateDelay(played, heard), 180);
});

test('estimateDelay: a stray noise does not spoil the median, and too few clicks heard give null', () => {
  const played = [1, 1.8, 2.6, 3.4, 4.2, 5];
  assert.equal(estimateDelay(played, [1.15, 1.95, 2.75, 3.55, 4.35, 5.15, 6.5]), 150);
  assert.equal(estimateDelay(played, [1.2, 1.9]), null);
  assert.equal(estimateDelay(played, []), null);
});

test('splitRoundTrip: the reported output keeps its share and the rest is the input', () => {
  assert.deepEqual(splitRoundTrip(250, 100), { output: 100, input: 150 });
  assert.deepEqual(splitRoundTrip(80, 200), { output: 80, input: 0 }); // the output never exceeds the round trip
  assert.deepEqual(splitRoundTrip(250, 0), { output: 0, input: 250 });
});
