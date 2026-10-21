// The owner's statistics as the window shows them (the part of ui/stats.ts without the DOM).
import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareSeconds } from '../src/library-stats.ts';
import { activityBars, formatBytes, formatScore, formatSeconds, songName } from '../ui/stats.ts';

test('formatBytes: units of 1000, with a comma', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(999), '999 B');
  assert.equal(formatBytes(1500), '1,5 kB');
  assert.equal(formatBytes(340_000_000), '340 MB');
  assert.equal(formatBytes(1_230_000_000), '1,2 GB');
  assert.equal(formatBytes('junk'), '0 B');
});

test('formatSeconds and formatScore: no data becomes "—"', () => {
  assert.equal(formatSeconds(null), '—');
  assert.equal(formatSeconds(45.4), '45 s');
  assert.equal(formatSeconds(90), '1 min 30 s');
  assert.equal(formatSeconds(120), '2 min');
  assert.equal(formatScore(null), '—');
  assert.equal(formatScore(79.6), '80');
});

test('songName: artist and title, only one of them, or a fallback name', () => {
  assert.equal(songName({ artist: 'Adele', title: 'Hello' }), 'Adele — Hello');
  assert.equal(songName({ title: 'Hello', artist: null }), 'Hello');
  assert.equal(songName({ artist: '  ', title: ' ' }), '(sem nome)');
  assert.equal(songName(null), '(sem nome)');
});

test('activityBars: the last days in order, with zero on days without a song and at most 14 bars', () => {
  const today = new Date(Date.UTC(2026, 9, 14)); // 2026-10-14
  const bars = activityBars([{ day: '2026-10-14', songs: 5 }, { day: '2026-10-12', songs: 2 }, { day: '2026-01-01', songs: 9 }], 30, today);
  assert.equal(bars.length, 14);
  assert.deepEqual(bars.slice(-3), [{ day: '2026-10-12', songs: 2 }, { day: '2026-10-13', songs: 0 }, { day: '2026-10-14', songs: 5 }]);
  assert.equal(activityBars([], 7, today).length, 7);
  assert.equal(bars.some((bar) => bar.day === '2026-01-01'), false); // outside the 14-day window
});

test('prepareSeconds: adds up the steps the worker recorded; without a record it is null', () => {
  assert.equal(prepareSeconds({ timings_s: { download: 10.2, separate: 50, key: 1.1 } }), 61.3);
  assert.equal(prepareSeconds({ timings_s: {} }), null);
  assert.equal(prepareSeconds({}), null);
  assert.equal(prepareSeconds(null), null);
});
