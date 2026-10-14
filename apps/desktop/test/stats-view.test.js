// Os números das estatísticas do dono como aparecem na janela (a parte sem DOM do ui/stats.js).
import assert from 'node:assert/strict';
import test from 'node:test';
import { prepareSeconds } from '../src/library-stats.js';
import { activityBars, formatBytes, formatScore, formatSeconds, songName } from '../ui/stats.js';

test('formatBytes: unidades de 1000, com vírgula', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(999), '999 B');
  assert.equal(formatBytes(1500), '1,5 kB');
  assert.equal(formatBytes(340_000_000), '340 MB');
  assert.equal(formatBytes(1_230_000_000), '1,2 GB');
  assert.equal(formatBytes('lixo'), '0 B');
});

test('formatSeconds e formatScore: sem dado vira "—"', () => {
  assert.equal(formatSeconds(null), '—');
  assert.equal(formatSeconds(45.4), '45 s');
  assert.equal(formatSeconds(90), '1 min 30 s');
  assert.equal(formatSeconds(120), '2 min');
  assert.equal(formatScore(null), '—');
  assert.equal(formatScore(79.6), '80');
});

test('songName: artista e título, só um deles ou um nome de reserva', () => {
  assert.equal(songName({ artist: 'Adele', title: 'Hello' }), 'Adele — Hello');
  assert.equal(songName({ title: 'Hello', artist: null }), 'Hello');
  assert.equal(songName({ artist: '  ', title: ' ' }), '(sem nome)');
  assert.equal(songName(null), '(sem nome)');
});

test('activityBars: os últimos dias em ordem, com zero nos dias sem música e no máximo 14 barras', () => {
  const today = new Date(Date.UTC(2026, 9, 14)); // 14/10/2026
  const bars = activityBars([{ day: '2026-10-14', songs: 5 }, { day: '2026-10-12', songs: 2 }, { day: '2026-01-01', songs: 9 }], 30, today);
  assert.equal(bars.length, 14);
  assert.deepEqual(bars.slice(-3), [{ day: '2026-10-12', songs: 2 }, { day: '2026-10-13', songs: 0 }, { day: '2026-10-14', songs: 5 }]);
  assert.equal(activityBars([], 7, today).length, 7);
  assert.equal(bars.some((bar) => bar.day === '2026-01-01'), false); // fora da janela de 14 dias
});

test('prepareSeconds: soma os passos anotados pelo worker; sem anotação é null', () => {
  assert.equal(prepareSeconds({ timings_s: { download: 10.2, separate: 50, key: 1.1 } }), 61.3);
  assert.equal(prepareSeconds({ timings_s: {} }), null);
  assert.equal(prepareSeconds({}), null);
  assert.equal(prepareSeconds(null), null);
});
