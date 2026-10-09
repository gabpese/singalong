import assert from 'node:assert/strict';
import test from 'node:test';
import { createScorer, detectPitch, hzToMidi, noteName, smoothMelody, pitchClassDistance, rms } from '../src/lib/scoring.js';

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
const FRAMES = 40; // um bloco de 2 s tem 40 quadros de 50 ms

/** Roda o cantor `sing(quadro, notaDaOriginal)` pela música inteira lendo o microfone a cada 100 ms. */
function run(midi, sing, opts) {
  const s = createScorer({ hop: 0.05, midi }, opts);
  for (let i = 0; i < midi.length; i += 2) s.tick(i * 0.05 + 0.01, sing(i, midi[i]));
  return s;
}
const steady = [...hold(60, FRAMES), ...hold(67, FRAMES), ...hold(-1, 10), ...hold(64, FRAMES)]; // 3 notas e uma pausa

test('createScorer: acertar tudo = 100, silêncio = 0, só contam os quadros com voz na original', () => {
  assert.equal(run(steady, (i, m) => (m < 0 ? null : m)).score(), 100);
  assert.equal(run(steady, () => null).score(), 0);
  assert.equal(run(steady, (i, m) => (m < 0 ? null : m)).evaluated, 60); // 120 quadros com voz, lidos de 2 em 2
  assert.equal(run(steady, (i, m) => (m < 0 ? null : m + 12)).score(), 100); // uma oitava acima também vale
});

test('createScorer: confere UMA nota por bloco de 2 s e ignora as trocas dentro dele', () => {
  // a original varia dentro do bloco (60 por 60% do tempo, 62 pelo resto); quem canta a nota principal acerta
  const wobbling = [...hold(60, 24), ...hold(62, 16)];
  const s = run(wobbling, (i, m) => m);
  assert.equal(s.score(), 100);
  assert.equal(s.reference, 60); // a "original" mostrada é uma só durante o bloco
});

test('createScorer: nota errada não pontua, quase certa vale a maior parte, falhas do detector não punem', () => {
  const sing = (offset, every = 1) => run(hold(60, FRAMES * 2), (i) => (i % (2 * every) === 0 ? 60 + offset : null)).score();
  assert.equal(sing(5), 0); // quinta errada
  assert.equal(sing(3), 50); // erro pequeno: pontua pela metade
  assert.equal(sing(2), 80); // quase: a maior parte do ponto
  assert.equal(sing(1), 100);
  assert.equal(sing(0, 2), 100); // o detector só pega metade das leituras
  assert.ok(sing(0, 20) < 40); // quase mudo: 1 leitura em 20 (com a nota segurada, ~10% dos quadros)
});

test('createScorer: o tom escolhido desloca a melodia e um quadro não conta duas vezes', () => {
  const s = createScorer({ hop: 0.05, midi: hold(60, FRAMES) }, { transpose: 2 });
  s.tick(0.01, 62);
  s.tick(0.02, 40); // mesmo quadro: ignorado
  assert.equal(s.score(), 100);
  assert.equal(s.evaluated, 1);
  assert.equal(s.reference, 62);
  assert.equal(createScorer({ hop: 0.05, midi: hold(60, FRAMES) }).score(), null);
});

test('createScorer: cantar uma nota fixa por cima de uma melodia que varia não rende nota alta', () => {
  const notes = [60, 67, 64, 69, 62, 66, 65, 70];
  const midi = Array.from({ length: 320 }, (_, i) => notes[Math.floor(i / FRAMES) % notes.length]); // uma nota por bloco
  assert.ok(run(midi, () => 60).score() < 40);
  assert.equal(run(midi, (i, m) => m).score(), 100);
});

test('createScorer: segura a última nota por 150 ms (consoantes e respirações não contam como silêncio)', () => {
  const s = createScorer({ hop: 0.05, midi: hold(60, FRAMES * 2) });
  s.tick(0.0, 60);
  s.tick(0.05, null);
  s.tick(0.1, null);
  assert.equal(s.score(), 100);
  assert.equal(s.sung, 60); // C4
  s.tick(2.5, null); // outro bloco, 2,5 s depois: silêncio de verdade
  assert.equal(s.score(), 75);
});

test('noteName: nome da nota com a oitava', () => {
  assert.equal(noteName(69), 'A4');
  assert.equal(noteName(60), 'C4');
  assert.equal(noteName(61.4), 'C#4');
  assert.equal(noteName(null), '—');
  assert.equal(noteName(-1), '—');
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

test('createScorer: onBlock e report descrevem a comparação (trecho, nota original, nota cantada)', () => {
  const logged = [];
  const midi = [...hold(60, FRAMES), ...hold(67, FRAMES)];
  const s = createScorer({ hop: 0.05, midi }, { onBlock: (row) => logged.push(row) });
  for (let i = 0; i < midi.length; i += 2) s.tick(i * 0.05 + 0.01, i < FRAMES ? 60 : 62); // acerta o 1º bloco, erra o 2º
  assert.equal(logged.length, 1); // o 2º bloco ainda não terminou
  assert.deepEqual(logged[0], { trecho: '00:00–00:02', original: 'C4', principais: 'C', cantada: 'C4', distancia: 0, acerto: 1, leituras: '20/20', participacao: 1 });
  const [first, second] = s.report();
  assert.equal(first.trecho, '00:00–00:02');
  assert.deepEqual([second.trecho, second.original, second.cantada, second.distancia, second.acerto], ['00:02–00:04', 'G4', 'D4', 5, 0]);
});

test('createScorer: se a original passa por várias notas no bloco, vale a mais frequente (não zero)', () => {
  const wandering = [...hold(60, 14), ...hold(63, 13), ...hold(66, 13)]; // nenhuma chega a 40% do bloco
  assert.equal(run(wandering, () => 60).score(), 100);
  assert.equal(run(wandering, () => 60).report()[0].principais, 'C');
});

test('createScorer: a nota cantada mostrada tem a oitava de quem canta', () => {
  const s = createScorer({ hop: 0.05, midi: hold(57, FRAMES) }); // original: A3
  for (let i = 0; i < FRAMES; i += 2) s.tick(i * 0.05 + 0.01, i < 10 ? 57 : 69); // a pessoa canta A4 na maior parte
  assert.equal(noteName(s.reference), 'A3');
  assert.equal(noteName(s.sung), 'A4');
  assert.equal(s.score(), 100); // a oitava não muda a pontuação
});
