import assert from 'node:assert/strict';
import test from 'node:test';
import { createScorer, detectPitch, hzToMidi, pitchClassDistance, rms } from '../public/scoring.js';

const sine = (hz, sampleRate = 48000, n = 2048, amp = 0.5) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / sampleRate));

test('detectPitch acha o tom de senóides de voz (com erro menor que 1%)', () => {
  for (const hz of [110, 220, 440, 880]) {
    const found = detectPitch(sine(hz), 48000);
    assert.ok(Math.abs(found - hz) / hz < 0.01, `${hz} Hz -> ${found}`);
  }
  assert.ok(Math.abs(hzToMidi(detectPitch(sine(440), 48000)) - 69) < 0.1);
});

test('detectPitch devolve null para silêncio e ruído', () => {
  assert.equal(detectPitch(new Float32Array(2048), 48000), null);
  const noise = Float32Array.from({ length: 2048 }, (_, i) => Math.sin(i * i * 12.9898) * 0.5);
  assert.equal(detectPitch(noise, 48000), null);
  assert.ok(rms(sine(440)) > 0.3);
});

test('pitchClassDistance ignora a oitava e é circular', () => {
  assert.equal(pitchClassDistance(60, 72), 0);
  assert.equal(pitchClassDistance(60, 71), 1);
  assert.equal(pitchClassDistance(61, 66), 5);
  assert.equal(pitchClassDistance(60, 66), 6);
});

const melody = { hop: 0.05, midi: [60, 60, -1, 64, 64, 64, -1, -1, 67, 67] };

test('createScorer: acertar tudo = 100, silêncio = 0, só contam os quadros com voz', () => {
  const sing = (fn, opts) => {
    const s = createScorer(melody, opts);
    melody.midi.forEach((_, i) => s.tick(i * 0.05 + 0.01, fn(melody.midi[i])));
    return s;
  };
  assert.equal(sing((m) => (m < 0 ? null : m)).score(), 100);
  assert.equal(sing(() => null).score(), 0);
  assert.equal(sing((m) => (m < 0 ? null : m)).evaluated, 7);
  assert.equal(sing((m) => (m < 0 ? null : m + 12)).score(), 100); // uma oitava acima também vale
  assert.equal(sing((m) => (m < 0 ? null : m + 5)).score(), 0); // quinta errada
  assert.equal(sing((m) => (m < 0 ? null : m + 2)).score(), 50); // quase: meio ponto
});

test('createScorer: o tom escolhido desloca a melodia e um quadro não conta duas vezes', () => {
  const s = createScorer(melody, { transpose: 2 });
  s.tick(0.01, 62);
  s.tick(0.02, 40); // mesmo quadro: ignorado
  assert.equal(s.score(), 100);
  assert.equal(s.evaluated, 1);
  assert.equal(createScorer(melody).score(), null);
});

test('createScorer: tolera o atraso do microfone (a nota certa chega até 200 ms depois)', () => {
  const s = createScorer({ hop: 0.05, midi: [60, 60, 60, 60, 67, 67, 67, 67] });
  s.tick(0.01, 60);
  s.tick(0.21, 60); // a referência já mudou para 67, mas o cantor ainda termina a nota anterior
  assert.equal(s.score(), 100);
});
