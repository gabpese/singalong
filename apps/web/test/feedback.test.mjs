import assert from 'node:assert/strict';
import test from 'node:test';
import { createFeedbackGuard, FEEDBACK, findTonalPeak } from '../src/lib/feedback.js';

const SR = 48000;
const BINS = 1024; // fftSize 2048
const binOf = (hz) => Math.round((hz * 2 * BINS) / SR);

/** Espectro em dB: piso de ruído com uma oscilação fixa e os picos pedidos ({ hz, db }), cada um com o formato de um tom estreito. */
function spectrum(peaks = [], floor = -80) {
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

/** Roda a guarda por `frames` quadros de 50 ms; `make(i)` devolve o espectro de cada um. */
function run(guard, frames, make, start = 0) {
  const results = [];
  for (let i = 0; i < frames; i++) results.push(guard.update(make(i), start + i * 50, SR));
  return results;
}

test('findTonalPeak: acha um tom puro e ignora ruído e voz com harmónicos', () => {
  assert.equal(findTonalPeak(spectrum(), SR), null); // só ruído
  const tone = findTonalPeak(spectrum([{ hz: 2400, db: -30 }]), SR);
  assert.ok(tone && Math.abs(tone.bin - binOf(2400)) <= 1 && tone.prominence > 25);
  // voz: fundamental com 2º e 3º harmónicos fortes
  const voice = spectrum([{ hz: 440, db: -25 }, { hz: 880, db: -28 }, { hz: 1320, db: -31 }]);
  assert.equal(findTonalPeak(voice, SR), null);
  assert.equal(findTonalPeak(spectrum([{ hz: 2400, db: -60 }]), SR), null); // fraco demais
  assert.equal(findTonalPeak(spectrum([{ hz: 100, db: -20 }]), SR), null); // abaixo de 200 Hz
});

test('um tom puro que cresce corta o volume pela metade; continuando, corta de novo', () => {
  const guard = createFeedbackGuard();
  const results = run(guard, 40, (i) => spectrum([{ hz: 2400, db: -40 + i * 0.7 }]));
  const triggers = results.filter((r) => r.triggered);
  assert.ok(triggers.length >= 2, `cortes: ${triggers.length}`);
  assert.equal(triggers[0].factor, 0.5);
  assert.ok(Math.abs(triggers[0].hz - 2400) < 60);
  assert.ok(guard.factor <= 0.25);
});

test('uma nota cantada sustentada, com harmónicos, nunca dispara (mesmo subindo de volume)', () => {
  const guard = createFeedbackGuard();
  const results = run(guard, 100, (i) => spectrum([{ hz: 440, db: -35 + i * 0.1 }, { hz: 880, db: -38 + i * 0.1 }, { hz: 1320, db: -41 + i * 0.1 }]));
  assert.equal(results.some((r) => r.triggered), false);
  assert.equal(guard.factor, 1);
});

test('um tom que muda de frequência a cada instante (vibrato largo, sirene) não dispara', () => {
  const guard = createFeedbackGuard();
  const results = run(guard, 60, (i) => spectrum([{ hz: 1000 + (i % 2) * 400, db: -30 + i * 0.5 }]));
  assert.equal(results.some((r) => r.triggered), false);
});

test('um tom muito forte e fixo por 0,8 s também dispara, mesmo sem crescer', () => {
  const guard = createFeedbackGuard();
  const results = run(guard, 25, () => spectrum([{ hz: 3000, db: -20 }]));
  assert.ok(results.some((r) => r.triggered));
});

test('depois do apito o volume volta devagar, sem passar de 80 % do ponto em que ele apareceu', () => {
  const guard = createFeedbackGuard();
  run(guard, 20, (i) => spectrum([{ hz: 2400, db: -40 + i * 1.2 }]));
  const cut = guard.factor;
  assert.ok(cut < 1);
  // silêncio: espera 3 s e depois sobe aos poucos
  const quiet = run(guard, 400, () => spectrum(), 2000); // 20 s
  assert.equal(quiet.some((r) => r.triggered), false);
  assert.ok(guard.factor > cut, 'voltou a subir');
  assert.ok(guard.factor <= 0.8 + 1e-9, `limite: ${guard.factor}`);
  // um minuto sem apito esquece o limite e volta ao normal
  run(guard, 1300, () => spectrum(), 30_000);
  assert.ok(guard.factor > 0.99);
});

test('o fator nunca cai abaixo do mínimo', () => {
  const guard = createFeedbackGuard();
  run(guard, 600, (i) => spectrum([{ hz: 2400, db: -40 + (i % 20) * 1.0 }]));
  assert.ok(guard.factor >= FEEDBACK.minFactor);
});
