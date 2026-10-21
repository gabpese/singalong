import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeParts, encodeParts, myPart, partAtTime, partName, singsAt, splitParts } from '../src/lib/duet.ts';

type Cues = Parameters<typeof splitParts>[0];

const cues = (...texts: string[]) => texts.map((text, i) => ({ start: i * 4, end: i * 4 + 3, text }));

test('without a chorus the lines alternate: a, b, a, b...', () => {
  assert.deepEqual(splitParts(cues('First verse here', 'Second verse here', 'Third verse here', 'Fourth verse here')), ['a', 'b', 'a', 'b']);
});

test('lines that repeat (the chorus) belong to both, and the alternation goes on where it stopped', () => {
  const parts = splitParts(cues('Verse one of the song', "Let's sing together now", 'Verse two of the song', "Let's sing together now", 'Verse three of the song'));
  assert.deepEqual(parts, ['a', 'both', 'b', 'both', 'a']);
});

test('capitals, punctuation and accents do not hide a repeated chorus', () => {
  assert.deepEqual(splitParts(cues('Eu não sei, não sei!', 'Something quite different here', 'EU NAO SEI NAO SEI')), ['both', 'a', 'both']);
});

test('very short lines that repeat (oh, yeah) do not become a chorus', () => {
  assert.deepEqual(splitParts(cues('Oh oh', 'A really long verse indeed', 'Oh oh', 'Another really long verse indeed')), ['a', 'b', 'a', 'b']);
});

test('empty lines have no part and do not count in the alternation', () => {
  assert.deepEqual(splitParts(cues('Verse one of the song', '', '   ', 'Verse two of the song', 'Verse three of the song')), ['a', null, null, 'b', 'a']);
});

test('empty or invalid lyrics do not break', () => {
  assert.deepEqual(splitParts([]), []);
  assert.deepEqual(splitParts(undefined), []);
  assert.deepEqual(splitParts([{ start: 0, end: 1 }, null] as unknown as Cues), [null, null]);
});

test("the song's owner is turquoise and the guest violet", () => {
  const owner = { mine: true, guest_me: false };
  const guest = { mine: false, guest_me: true };
  assert.equal(myPart(owner), 'a');
  assert.equal(myPart(guest), 'b');
  assert.equal(myPart(null), 'a');
  assert.deepEqual((['a', 'b', 'both'] as const).map((part) => partName(part)), ['turquesa', 'violeta', 'os dois']);
});

test("the split the singers chose holds when it fits the lyrics; otherwise the automatic one comes back", () => {
  const lines = [{ text: 'First line' }, { text: 'Second line' }, { text: '' }, { text: 'Fourth line' }] as unknown as Cues;
  assert.deepEqual(splitParts(lines, 'ba-*'), ['b', 'a', null, 'both']);
  assert.deepEqual(splitParts(lines, 'ba-'), splitParts(lines)); // the size does not fit (the lyrics changed): automatic
  assert.deepEqual(splitParts(lines, 'baxz'), splitParts(lines)); // odd letters: automatic
  assert.deepEqual(splitParts(lines, null), splitParts(lines));
  assert.deepEqual(decodeParts('a*b-', 4), ['a', 'both', 'b', null]);
  assert.equal(decodeParts('a*b-', 5), null);
  assert.equal(encodeParts(['a', 'both', 'b', null]), 'a*b-');
  assert.equal(encodeParts(decodeParts('ab*-', 4) ?? []), 'ab*-'); // there and back
});

test('partAtTime and singsAt: who sings at an instant; the "together" lines count for both', () => {
  const lines = [{ start: 0, end: 2 }, { start: 3, end: 5 }, { start: 6, end: 8 }];
  const parts = ['a', 'b', 'both'] as const;
  assert.equal(partAtTime(lines, parts, 1), 'a');
  assert.equal(partAtTime(lines, parts, 2.5), null); // between the lines
  assert.equal(partAtTime(lines, parts, 4.99), 'b');
  assert.equal(partAtTime(lines, parts, 5), null); // the line's end does not count
  assert.equal(singsAt(lines, parts, 1, 'a'), true);
  assert.equal(singsAt(lines, parts, 1, 'b'), false);
  assert.equal(singsAt(lines, parts, 7, 'a') && singsAt(lines, parts, 7, 'b'), true);
  assert.equal(singsAt(lines, parts, 2.5, 'a'), false);
  assert.equal(singsAt([], [], 1, 'a'), false);
});
