import assert from 'node:assert/strict';
import test from 'node:test';
import { createScorer, detectPitch, hzToMidi, noteName, smoothMelody, pitchClassDistance, rms } from '../public/scoring.js';

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

const hold = (note, frames) => Array(frames).fill(note);
const melody = { hop: 0.05, midi: [...hold(60, 8), ...hold(-1, 2), ...hold(64, 8), ...hold(-1, 2), ...hold(67, 8)] }; // notas de 0,4 s e pausas

test('createScorer: acertar tudo = 100, silêncio = 0, só contam os quadros com voz', () => {
  const sing = (fn, opts) => {
    const s = createScorer(melody, opts);
    melody.midi.forEach((_, i) => s.tick(i * 0.05 + 0.01, fn(melody.midi[i])));
    return s;
  };
  assert.equal(sing((m) => (m < 0 ? null : m)).score(), 100);
  assert.equal(sing(() => null).score(), 0);
  assert.equal(sing((m) => (m < 0 ? null : m)).evaluated, 24);
  assert.equal(sing((m) => (m < 0 ? null : m + 12)).score(), 100); // uma oitava acima também vale
});

test('createScorer: nota errada não pontua, quase certa vale metade', () => {
  const long = { hop: 0.05, midi: Array(40).fill(60) };
  const sing = (offset) => {
    const s = createScorer(long);
    for (let i = 0; i < 40; i++) s.tick(i * 0.05 + 0.01, 60 + offset);
    return s.score();
  };
  assert.equal(sing(5), 0); // quinta errada
  assert.equal(sing(2), 50); // quase: meio ponto
  assert.equal(sing(1), 100);
});

test('createScorer: o tom escolhido desloca a melodia e um quadro não conta duas vezes', () => {
  const s = createScorer(melody, { transpose: 2 });
  s.tick(0.01, 62);
  s.tick(0.02, 40); // mesmo quadro: ignorado
  assert.equal(s.score(), 100);
  assert.equal(s.evaluated, 1);
  assert.equal(s.reference, 62);
  assert.equal(createScorer(melody).score(), null);
});

test('createScorer: tolera o atraso do microfone (a nota certa chega até 100 ms depois)', () => {
  const s = createScorer({ hop: 0.05, midi: [...hold(60, 10), ...hold(67, 10)] });
  s.tick(0.01, 60);
  s.tick(0.51, 60); // a referência já mudou para 67, mas o cantor ainda termina a nota anterior
  assert.equal(s.score(), 100);
});

test('noteName: nome da nota com a oitava', () => {
  assert.equal(noteName(69), 'A4');
  assert.equal(noteName(60), 'C4');
  assert.equal(noteName(61.4), 'C#4');
  assert.equal(noteName(null), '—');
  assert.equal(noteName(-1), '—');
});

test('createScorer: segura a última nota por 150 ms (consoantes e respirações não contam como silêncio)', () => {
  const s = createScorer({ hop: 0.05, midi: Array(60).fill(60) });
  s.tick(0.0, 60);
  s.tick(0.05, null); // 50 ms: ainda vale a nota segurada
  s.tick(0.1, null);
  assert.equal(s.score(), 100);
  s.tick(2.5, null); // 2,5 s depois, em outro trecho: silêncio de verdade
  assert.equal(s.score(), 75);
});

test('createScorer: pontua por trechos de 2 s, então errar um instante no meio de um trecho não derruba a nota', () => {
  const s = createScorer({ hop: 0.05, midi: Array(12).fill(60) });
  for (let i = 0; i < 12; i++) s.tick(i * 0.05 + 0.01, i === 2 || i === 8 ? 90 : 60); // um deslize em cada trecho
  assert.equal(s.score(), 100);
});

test('createScorer: falhas do detector (quadros sem tom) não viram erro de quem canta certo', () => {
  const s = createScorer({ hop: 0.05, midi: Array(80).fill(60) });
  for (let i = 0; i < 80; i++) s.tick(i * 0.05 + 0.01, i % 2 === 0 ? 60 : null); // detecta só metade dos quadros
  assert.equal(s.score(), 100);
  const quiet = createScorer({ hop: 0.05, midi: Array(80).fill(60) });
  for (let i = 0; i < 80; i++) quiet.tick(i * 0.05 + 0.01, i % 40 === 0 ? 60 : null); // quase mudo: só 10% dos quadros (com a nota segurada)
  assert.ok(quiet.score() < 40);
});

test('createScorer: tolera 1 semitom de erro (voz humana oscila) e dá meio ponto até 2', () => {
  const s = createScorer({ hop: 0.05, midi: Array(6).fill(60) });
  for (let i = 0; i < 6; i++) s.tick(i * 0.05 + 0.01, 60.9);
  assert.equal(s.score(), 100);
  const off = createScorer({ hop: 0.05, midi: Array(6).fill(60) });
  for (let i = 0; i < 6; i++) off.tick(i * 0.05 + 0.01, 61.7);
  assert.equal(off.score(), 50);
});

test('createScorer: cantar uma nota fixa por cima de uma melodia que varia não rende nota alta', () => {
  const notes = [60, 67, 62, 69, 64, 71, 65, 72];
  const midi = Array.from({ length: 320 }, (_, i) => notes[Math.floor(i / 20) % notes.length]); // cada nota dura 1 s
  const drone = createScorer({ hop: 0.05, midi });
  const singer = createScorer({ hop: 0.05, midi });
  for (let i = 0; i < 320; i++) {
    drone.tick(i * 0.05 + 0.01, 60);
    singer.tick(i * 0.05 + 0.01, midi[i]);
  }
  assert.ok(drone.score() < 40, `nota fixa: ${drone.score()}`);
  assert.equal(singer.score(), 100);
});

test('smoothMelody: vibrato, picos do detector e trechos curtos viram notas estáveis', () => {
  const wobble = [...Array(10).fill(60), 61, 60, 59, 60, 61, 60, 60, 60, 59, 60]; // vibrato de 1 semitom
  assert.deepEqual(smoothMelody(wobble), Array(20).fill(60));
  const spike = [...hold(60, 10), 72, ...hold(60, 9)]; // um quadro com erro de oitava
  assert.deepEqual(smoothMelody(spike), Array(20).fill(60));
  const short = [...hold(60, 10), ...hold(67, 3), ...hold(60, 10)]; // 150 ms em outra nota: absorvido
  assert.deepEqual(smoothMelody(short), Array(23).fill(60));
  const steps = [...hold(60, 8), ...hold(64, 8), -1, -1, ...hold(67, 8)];
  assert.deepEqual(smoothMelody(steps), [...hold(60, 8), ...hold(64, 8), -1, -1, ...hold(67, 8)]); // trocas reais ficam
  assert.deepEqual(smoothMelody(hold(60, 3)), hold(-1, 3)); // nota isolada curta demais: some
});
