import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clampPitch, describeLyricsSource, formatTime, isTypingTarget, lineProgress, locate, looksLikeLink, wordProgress, wordSpans,
} from '../public/lyrics-sync.js';

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

test('formatTime', () => {
  assert.equal(formatTime(0), '0:00');
  assert.equal(formatTime(222.3), '3:42');
  assert.equal(formatTime(undefined), '0:00');
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

test('isTypingTarget: campos de texto não perdem a digitação para os atalhos', () => {
  assert.equal(isTypingTarget({ tagName: 'INPUT', type: 'text' }), true);
  assert.equal(isTypingTarget({ tagName: 'INPUT' }), true);
  assert.equal(isTypingTarget({ tagName: 'TEXTAREA' }), true);
  assert.equal(isTypingTarget({ tagName: 'SELECT' }), true);
  assert.equal(isTypingTarget({ tagName: 'BUTTON' }), true);
  assert.equal(isTypingTarget({ tagName: 'DIV', isContentEditable: true }), true);
  // sliders e o corpo da página continuam recebendo os atalhos
  assert.equal(isTypingTarget({ tagName: 'INPUT', type: 'range' }), false);
  assert.equal(isTypingTarget({ tagName: 'BODY' }), false);
  assert.equal(isTypingTarget(null), false);
});

test('looksLikeLink: link vs pesquisa por nome', () => {
  for (const v of ['https://www.youtube.com/watch?v=TLvtw4nXou0', 'youtu.be/TLvtw4nXou0', 'http://m.youtube.com/shorts/abc', 'TLvtw4nXou0', '  https://youtu.be/x  ']) {
    assert.equal(looksLikeLink(v), true, v);
  }
  for (const v of ["jack's lament", 'Faouzia Unethical', 'a', '', undefined]) {
    assert.equal(looksLikeLink(v), false, String(v));
  }
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
