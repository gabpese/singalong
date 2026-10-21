// The interface hides the technical side: no text mentions Whisper, Demucs, LRC or semitones, or includes an emoji (the
// "Cyber-Club" look's choice).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import en from '../src/i18n/en.ts';
import es from '../src/i18n/es.ts';
import pt from '../src/i18n/pt.ts';

const TECHNICAL = /whisper|demucs|\blrc\b|\.lrc|\.srt|semiton|semitone|\bia\b|\bai\b/i;
// real emojis (note symbols such as ♯ and ♭, and ✓, are still fine)
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{1F000}-\u{1F2FF}]/u;

for (const [name, catalog] of [['pt', pt], ['en', en], ['es', es]] as const) {
  test(`${name}: no interface text has a technical term or an emoji`, () => {
    for (const [key, text] of Object.entries(catalog)) {
      assert.doesNotMatch(text, TECHNICAL, `${name}.${key}: a technical term in "${text}"`);
      assert.doesNotMatch(text, EMOJI, `${name}.${key}: an emoji in "${text}"`);
    }
  });
}

test('the messages while a song is prepared are playful, and the key is picked with "Mais grave" and "Mais agudo"', () => {
  assert.equal(pt['stage.separating'], 'Isolando a banda…');
  assert.equal(pt['stage.aligning'], 'Afinando os microfones…');
  assert.equal(pt['pitch.lower'], 'Mais grave');
  assert.equal(pt['pitch.higher'], 'Mais agudo');
});

test("en and es have every key of the Portuguese catalog (and none more)", () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(pt).sort());
  assert.deepEqual(Object.keys(es).sort(), Object.keys(pt).sort());
});
