// A interface esconde a parte técnica: nenhum texto fala em Whisper, Demucs, LRC, semitons ou inclui emoji (a escolha da estética "Cyber-Club").
import assert from 'node:assert/strict';
import { test } from 'node:test';
import en from '../src/i18n/en.js';
import es from '../src/i18n/es.js';
import pt from '../src/i18n/pt.js';

const TECHNICAL = /whisper|demucs|\blrc\b|\.lrc|\.srt|semiton|semitone|\bia\b|\bai\b/i;
// emojis de verdade (símbolos de nota como ♯ e ♭ e o ✓ continuam valendo)
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}]/u;

for (const [name, catalog] of [['pt', pt], ['en', en], ['es', es]]) {
  test(`${name}: nenhum texto da interface tem termo técnico nem emoji`, () => {
    for (const [key, text] of Object.entries(catalog)) {
      assert.doesNotMatch(text, TECHNICAL, `${name}.${key}: termo técnico em "${text}"`);
      assert.doesNotMatch(text, EMOJI, `${name}.${key}: emoji em "${text}"`);
    }
  });
}

test('as mensagens de preparo da música são lúdicas, e o tom se escolhe com "Mais grave" e "Mais agudo"', () => {
  assert.equal(pt['stage.separating'], 'Isolando a banda…');
  assert.equal(pt['stage.aligning'], 'Afinando os microfones…');
  assert.equal(pt['pitch.lower'], 'Mais grave');
  assert.equal(pt['pitch.higher'], 'Mais agudo');
});

test('en e es têm todas as chaves do português (e nenhuma a mais)', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(pt).sort());
  assert.deepEqual(Object.keys(es).sort(), Object.keys(pt).sort());
});
