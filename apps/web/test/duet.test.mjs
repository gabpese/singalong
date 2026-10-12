import assert from 'node:assert/strict';
import test from 'node:test';
import { myPart, PART_NAMES, splitParts } from '../src/lib/duet.js';

const cues = (...texts) => texts.map((text, i) => ({ start: i * 4, end: i * 4 + 3, text }));

test('sem refrão as linhas se alternam: a, b, a, b...', () => {
  assert.deepEqual(splitParts(cues('Primeiro verso aqui', 'Segundo verso aqui', 'Terceiro verso aqui', 'Quarto verso aqui')), ['a', 'b', 'a', 'b']);
});

test('linhas que se repetem (o refrão) são dos dois, e a alternância continua de onde parou', () => {
  const parts = splitParts(cues('Verso um da música', 'Vamos cantar juntos agora', 'Verso dois da música', 'Vamos cantar juntos agora', 'Verso três da música'));
  assert.deepEqual(parts, ['a', 'both', 'b', 'both', 'a']);
});

test('maiúsculas, pontuação e acentos não escondem um refrão repetido', () => {
  assert.deepEqual(splitParts(cues('Eu não sei, não sei!', 'Algo bem diferente aqui', 'EU NAO SEI NAO SEI')), ['both', 'a', 'both']);
});

test('linhas muito curtas que repetem (oh, yeah) não viram refrão', () => {
  assert.deepEqual(splitParts(cues('Oh oh', 'Um verso comprido de verdade', 'Oh oh', 'Outro verso comprido de verdade')), ['a', 'b', 'a', 'b']);
});

test('linhas vazias não têm parte e não contam na alternância', () => {
  assert.deepEqual(splitParts(cues('Verso um da música', '', '   ', 'Verso dois da música', 'Verso três da música')), ['a', null, null, 'b', 'a']);
});

test('letra vazia ou inválida não quebra', () => {
  assert.deepEqual(splitParts([]), []);
  assert.deepEqual(splitParts(undefined), []);
  assert.deepEqual(splitParts([{ start: 0, end: 1 }, null]), [null, null]);
});

test('o dono da música é o verde e o convidado o vermelho', () => {
  assert.equal(myPart({ mine: true, guest_me: false }), 'a');
  assert.equal(myPart({ mine: false, guest_me: true }), 'b');
  assert.equal(myPart(null), 'a');
  assert.deepEqual(PART_NAMES, { a: 'verde', b: 'vermelho', both: 'os dois' });
});
