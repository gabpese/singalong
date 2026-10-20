import assert from 'node:assert/strict';
import test from 'node:test';
import { myPart, partName, splitParts } from '../src/lib/duet.ts';

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

test('o dono da música é o turquesa e o convidado o violeta', () => {
  assert.equal(myPart({ mine: true, guest_me: false }), 'a');
  assert.equal(myPart({ mine: false, guest_me: true }), 'b');
  assert.equal(myPart(null), 'a');
  assert.deepEqual(['a', 'b', 'both'].map(partName), ['turquesa', 'violeta', 'os dois']);
});

test('a divisão escolhida pelos cantores vale quando combina com a letra; senão volta a automática', async () => {
  const { decodeParts, encodeParts, splitParts } = await import('../src/lib/duet.ts');
  const cues = [{ text: 'Primeira linha' }, { text: 'Segunda linha' }, { text: '' }, { text: 'Quarta linha' }];
  assert.deepEqual(splitParts(cues, 'ba-*'), ['b', 'a', null, 'both']);
  assert.deepEqual(splitParts(cues, 'ba-'), splitParts(cues)); // o tamanho não combina (a letra mudou): automática
  assert.deepEqual(splitParts(cues, 'baxz'), splitParts(cues)); // letras estranhas: automática
  assert.deepEqual(splitParts(cues, null), splitParts(cues));
  assert.deepEqual(decodeParts('a*b-', 4), ['a', 'both', 'b', null]);
  assert.equal(decodeParts('a*b-', 5), null);
  assert.equal(encodeParts(['a', 'both', 'b', null]), 'a*b-');
  assert.equal(encodeParts(decodeParts('ab*-', 4)), 'ab*-'); // vai e volta
});

test('partAtTime e singsAt: quem canta no instante; as linhas "juntos" contam para os dois', async () => {
  const { partAtTime, singsAt } = await import('../src/lib/duet.ts');
  const cues = [{ start: 0, end: 2 }, { start: 3, end: 5 }, { start: 6, end: 8 }];
  const parts = ['a', 'b', 'both'];
  assert.equal(partAtTime(cues, parts, 1), 'a');
  assert.equal(partAtTime(cues, parts, 2.5), null); // entre as linhas
  assert.equal(partAtTime(cues, parts, 4.99), 'b');
  assert.equal(partAtTime(cues, parts, 5), null); // o fim da linha não conta
  assert.equal(singsAt(cues, parts, 1, 'a'), true);
  assert.equal(singsAt(cues, parts, 1, 'b'), false);
  assert.equal(singsAt(cues, parts, 7, 'a') && singsAt(cues, parts, 7, 'b'), true);
  assert.equal(singsAt(cues, parts, 2.5, 'a'), false);
  assert.equal(singsAt([], [], 1, 'a'), false);
});
