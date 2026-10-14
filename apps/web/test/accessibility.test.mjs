import assert from 'node:assert/strict';
import test from 'node:test';
import { LYRICS_SCALES, stepScale } from '../src/lib/accessibility.js';

test('stepScale: anda pela lista e para nos extremos', () => {
  assert.equal(stepScale(1, 1), 1.25);
  assert.equal(stepScale(1, -1), 0.8);
  assert.equal(stepScale(LYRICS_SCALES.at(-1), 1), LYRICS_SCALES.at(-1));
  assert.equal(stepScale(LYRICS_SCALES[0], -1), LYRICS_SCALES[0]);
  assert.equal(stepScale(1.3, 1), 1.5); // valor fora da lista: parte do mais próximo
});
