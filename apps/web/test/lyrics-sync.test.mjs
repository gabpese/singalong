import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clampPitch, describeLyricsSource, lineProgress, locate, wordProgress, wordSpans,
} from '../src/lib/lyrics-sync.js';

const cues = [
  { start: 10, end: 12, text: 'a' },
  { start: 12, end: 14, text: 'b' },
  { start: 20, end: 25, text: 'c' },
];

test('locate: antes da primeira linha', () => {
  assert.deepEqual(locate(cues, 0), { current: -1, next: 0 });
  assert.deepEqual(locate(cues, 9.99), { current: -1, next: 0 });
});

test('locate: dentro de uma linha e na fronteira', () => {
  assert.deepEqual(locate(cues, 10), { current: 0, next: 1 });
  assert.deepEqual(locate(cues, 11.9), { current: 0, next: 1 });
  assert.deepEqual(locate(cues, 12), { current: 1, next: 2 }); // fim exclusivo, início inclusivo
});

test('locate: intervalo entre linhas e depois da última', () => {
  assert.deepEqual(locate(cues, 16), { current: -1, next: 2 });
  assert.deepEqual(locate(cues, 24.9), { current: 2, next: 3 });
  assert.deepEqual(locate(cues, 99), { current: -1, next: 3 });
});

test('locate: letra vazia', () => {
  assert.deepEqual(locate([], 5), { current: -1, next: 0 });
});

test('lineProgress', () => {
  assert.equal(lineProgress(cues[0], 10), 0);
  assert.equal(lineProgress(cues[0], 11), 0.5);
  assert.equal(lineProgress(cues[0], 50), 1);
  assert.equal(lineProgress({ start: 5, end: 5 }, 4), 0);
  assert.equal(lineProgress({ start: 5, end: 5 }, 6), 1);
});

test('clampPitch', () => {
  assert.equal(clampPitch(3.4), 3);
  assert.equal(clampPitch('-9'), -6);
  assert.equal(clampPitch(100), 6);
  assert.equal(clampPitch('abc'), 0);
});

test('wordSpans: frações crescentes e cobrindo a frase', () => {
  const spans = wordSpans('Lock me up');
  assert.deepEqual(spans.map((s) => s.word), ['Lock', 'me', 'up']);
  assert.equal(spans[0].from, 0);
  assert.equal(spans.at(-1).to, 1);
  for (let i = 1; i < spans.length; i++) assert.ok(spans[i].from >= spans[i - 1].to);
  assert.deepEqual(wordSpans(''), []);
});

test('wordProgress: preenche na ordem de leitura, sem depender de quebra de linha', () => {
  const spans = wordSpans('Lock me up and close the door when it rains');
  const at = (lineP) => spans.map((s) => wordProgress(s, lineP));
  assert.ok(at(0).every((p) => p === 0));
  assert.ok(at(1).every((p) => p === 1));
  const half = at(0.5);
  // nunca uma palavra posterior mais preenchida que uma anterior
  for (let i = 1; i < half.length; i++) assert.ok(half[i] <= half[i - 1], `palavra ${i}`);
  assert.equal(half[0], 1); // início cheio
  assert.equal(half.at(-1), 0); // última ainda vazia ("rains" não enche junto com o começo)
});

test('describeLyricsSource: nada de jargão na tela', () => {
  assert.equal(describeLyricsSource('none'), 'sem letra (só o instrumental)');
  assert.equal(describeLyricsSource('lrclib'), 'buscada na internet');
  assert.equal(describeLyricsSource('video'), 'legenda do vídeo');
  assert.equal(describeLyricsSource('align'), 'seu texto, sincronizado com a voz por IA');
  assert.equal(describeLyricsSource('lrclib+align'), 'buscada na internet, sincronizada com a voz por IA');
  assert.equal(describeLyricsSource('text+lrclib'), 'seu texto, com os tempos da busca na internet');
  assert.equal(describeLyricsSource('text+video'), 'seu texto, com os tempos da legenda do vídeo');
  assert.equal(describeLyricsSource(undefined), 'desconhecida');
});

// ---------- pausas longas: aviso "--------------" ----------
import { COUNTDOWN_SECONDS, GAP_DASHES, MIN_GAP_SECONDS, gapDisplay, sungEnd } from '../src/lib/lyrics-sync.js';

const song = [
  { start: 12, end: 16, text: 'primeira linha da música' }, // intro de 12 s
  { start: 17, end: 21, text: 'segunda linha' }, // pausa curta (1 s)
  { start: 40, end: 44, text: 'depois do solo' }, // solo de 19 s
  { start: 44.5, end: 48, text: 'última linha' },
];

test('sungEnd: mantém o fim de linhas com duração plausível para o texto', () => {
  assert.equal(sungEnd({ start: 10, end: 14, text: 'uma linha normal' }), 14); // 4 s para 16 letras (estimativa 3,9 s)
  assert.equal(sungEnd({ start: 10, end: 15.5, text: 'uma linha normal' }), 15.5); // até 1,5× a estimativa ainda vale
  assert.equal(sungEnd({ start: 0, end: 4 }), 4); // sem texto: não quebra, usa o mínimo de 3 s
});

test('sungEnd: linha longa demais para o texto é tratada como cantada na estimativa', () => {
  const hidden = { start: 100, end: 117.7, text: 'x'.repeat(45) }; // 17,7 s para 45 letras: tem um solo dentro
  assert.ok(Math.abs(sungEnd(hidden) - (100 + 0.12 * 45 + 2)) < 1e-9);
  assert.ok(Math.abs(sungEnd({ start: 10, end: 16, text: 'abcdefghij' }) - 13.2) < 1e-9); // 6 s para 10 letras: passa de 1,5×3,2
  assert.ok(sungEnd({ start: 0, end: 60, text: 'oi' }) < 10); // mínimo de 3 s de estimativa
});

test('gapDisplay: a introdução (≥ 8 s) mostra os 14 traços completos', () => {
  const g = gapDisplay(song, 2);
  assert.equal(g.next, 0);
  assert.equal(g.dashes, GAP_DASHES);
  assert.equal(g.dashes, 14);
  assert.ok(Math.abs(g.remaining - 10) < 1e-9);
});

test('gapDisplay: nos últimos 8 s os traços vão sumindo até a linha começar', () => {
  assert.equal(gapDisplay(song, 12 - COUNTDOWN_SECONDS - 0.5).dashes, 14); // ainda fora da contagem
  assert.equal(gapDisplay(song, 12 - 4).dashes, 7); // faltam 4 s de 8: metade
  assert.equal(gapDisplay(song, 12 - 2).dashes, 4); // faltam 2 s: ceil(14 × 2/8)
  assert.equal(gapDisplay(song, 12 - 0.1).dashes, 1); // quase na hora: ainda 1 traço
  assert.equal(gapDisplay(song, 12), null); // a linha começou
  const seen = [];
  for (let t = 4; t < 12; t += 0.5) seen.push(gapDisplay(song, t).dashes);
  assert.deepEqual(seen, [...seen].sort((a, b) => b - a)); // nunca aumenta
});

test('gapDisplay: pausas curtas não mostram aviso', () => {
  assert.equal(gapDisplay(song, 18), null); // dentro da linha 2
  assert.equal(gapDisplay(song, 16.5), null); // entre as linhas 1 e 2: 1 s
  assert.equal(gapDisplay([{ start: 7.9, end: 10, text: 'a' }], 0), null); // intro de 7,9 s
  assert.notEqual(gapDisplay([{ start: MIN_GAP_SECONDS, end: 12, text: 'a' }], 0), null); // exatamente 8 s: mostra
});

test('gapDisplay: solo no meio da música (a partir do fim da linha anterior)', () => {
  assert.equal(gapDisplay(song, 21.5).dashes, 14); // começou a pausa de 19 s
  assert.equal(gapDisplay(song, 21.5).next, 2);
  assert.equal(gapDisplay(song, 36).dashes, 7); // faltam 4 s
  assert.equal(gapDisplay(song, 40.1), null);
});

test('gapDisplay: solo escondido dentro de uma linha de LRC longa demais', () => {
  const lrc = [
    { start: 10, end: 14, text: 'antes' },
    { start: 14, end: 31.7, text: 'x'.repeat(45) }, // o LRC não marca o solo: a linha "dura" 17,7 s
    { start: 31.7, end: 36, text: 'depois' },
  ];
  assert.equal(gapDisplay(lrc, 15), null); // ainda cantando a linha
  const inSolo = gapDisplay(lrc, 25); // passou do tempo estimado (7,4 s): é pausa
  assert.equal(inSolo.next, 2);
  assert.ok(inSolo.remaining > 6 && inSolo.remaining < 7);
  assert.equal(gapDisplay(lrc, 32), null);
});

test('gapDisplay: sem aviso depois da última linha nem com letra vazia', () => {
  assert.equal(gapDisplay(song, 100), null);
  assert.equal(gapDisplay([], 3), null);
});

test('lineProgress usa o fim cantado: o preenchimento não se arrasta durante um solo', () => {
  const hidden = { start: 0, end: 20, text: 'x'.repeat(30) }; // estimativa = 5,6 s
  assert.equal(lineProgress(hidden, 5.6), 1);
  assert.ok(lineProgress(hidden, 2.8) > 0.45 && lineProgress(hidden, 2.8) < 0.55);
});

test('clampBacking: nível das vozes de apoio, inteiro de 0 a 100; inválido desliga', async () => {
  const { clampBacking } = await import('../src/lib/lyrics-sync.js');
  assert.equal(clampBacking(40), 40);
  assert.equal(clampBacking(40.6), 41);
  assert.equal(clampBacking(-10), 0);
  assert.equal(clampBacking(250), 100);
  assert.equal(clampBacking('55'), 55);
  assert.equal(clampBacking('muito'), 0);
  assert.equal(clampBacking(undefined), 0);
  assert.equal(clampBacking(null), 0);
});
