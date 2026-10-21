import assert from 'node:assert/strict';
import test from 'node:test';
import { isUncertain, keyLabel, keySummary, transposeKey } from '../src/lib/music.ts';

type SongKey = NonNullable<Parameters<typeof transposeKey>[0]>;

const key = (tonic: number, mode: string): SongKey => ({ tonic, mode });
const a: SongKey = { tonic: 9, mode: 'minor', margin: 0.2 }; // the mode is in the data, but not on screen

test('keyLabel: only the note, in solfège and in letters, without major or minor', () => {
  assert.equal(keyLabel(a), 'Lá (A)');
  assert.equal(keyLabel(key(0, 'major')), 'Dó (C)');
  assert.equal(keyLabel(key(11, 'minor')), 'Si (B)');
  assert.equal(keyLabel(key(1, 'major')), 'Dó♯ / Ré♭ (C#/Db)'); // accidentals show both names
  assert.equal(keyLabel(key(6, 'minor')), 'Fá♯ / Sol♭ (F#/Gb)');
  assert.equal(keyLabel(key(10, 'minor')), 'Lá♯ / Si♭ (A#/Bb)');
  assert.equal(keyLabel(null), '');
  // the same name for major and minor: the mode does not interfere
  assert.equal(keyLabel(key(3, 'major')), keyLabel(key(3, 'minor')));
});

test('the 12 notes have unique names and none mentions major or minor', () => {
  const labels = new Set<string>();
  for (let tonic = 0; tonic < 12; tonic++) {
    const label = keyLabel(key(tonic, 'major'));
    assert.match(label, /^(Dó|Ré|Mi|Fá|Sol|Lá|Si)[♯♭]?( \/ (Dó|Ré|Mi|Fá|Sol|Lá|Si)[♯♭])? \([A-G]#?b?(\/[A-G]#?b?)?\)$/);
    assert.doesNotMatch(label, /maior|menor/);
    labels.add(label);
  }
  assert.equal(labels.size, 12);
});

test('transposeKey: adds semitones and wraps around the octave', () => {
  assert.equal(transposeKey(a, 2)?.tonic, 11); // A +2 = B
  assert.equal(transposeKey(a, 3)?.tonic, 0); // wraps around
  assert.equal(transposeKey(a, -9)?.tonic, 0);
  assert.equal(transposeKey(a, -6)?.tonic, 3);
  assert.equal(transposeKey({ tonic: 0, mode: 'major' }, -1)?.tonic, 11);
  assert.equal(transposeKey(null, 2), null);
  assert.equal(a.tonic, 9); // the original is untouched
});

test('transposeKey moves the alternative key too', () => {
  const moved = transposeKey({ tonic: 5, mode: 'major', margin: 0.04, alt: { tonic: 2, mode: 'minor' } }, 2);
  assert.deepEqual([moved?.tonic, moved?.alt?.tonic], [7, 4]);
});

test('isUncertain: a small margin AND different notes between the 1st and the 2nd key', () => {
  assert.equal(isUncertain({ tonic: 0, mode: 'major', margin: 0.01 }), true); // no alternative given
  assert.equal(isUncertain({ tonic: 5, mode: 'major', margin: 0.079, alt: { tonic: 2, mode: 'minor' } }), true);
  assert.equal(isUncertain({ tonic: 5, mode: 'major', margin: 0.2, alt: { tonic: 2, mode: 'minor' } }), false);
  assert.equal(isUncertain({ tonic: 0, mode: 'major' }), false); // no margin given
  // the alternative has the SAME note (only the mode changes): there is no doubt about the note
  assert.equal(isUncertain({ tonic: 0, mode: 'major', margin: 0.01, alt: { tonic: 0, mode: 'minor' } }), false);
  assert.equal(isUncertain(null), false);
});

test('keySummary: the original note, and the note sung when there is a transposition', () => {
  assert.equal(keySummary(a, 0), 'Tom: Lá (A)');
  assert.equal(keySummary(a, 2), 'Tom: Lá (A) → agora em Si (B)');
  assert.equal(keySummary(a, -3), 'Tom: Lá (A) → agora em Fá♯ / Sol♭ (F#/Gb)');
  assert.equal(keySummary({ tonic: 0, mode: 'major', margin: 0.01 }, 0), 'Tom provável: Dó (C)'); // no alternative
  const ambiguous: SongKey = { tonic: 5, mode: 'major', margin: 0.04, alt: { tonic: 2, mode: 'minor' } };
  assert.equal(keySummary(ambiguous, 0), 'Tom provável: Fá (F) ou Ré (D)');
  assert.equal(keySummary(ambiguous, 2), 'Tom provável: Fá (F) ou Ré (D) → agora em Sol (G) ou Mi (E)');
  const sameNote: SongKey = { tonic: 0, mode: 'major', margin: 0.01, alt: { tonic: 0, mode: 'minor' } };
  assert.equal(keySummary(sameNote, 0), 'Tom: Dó (C)'); // the note is certain
  assert.equal(keySummary(null, 2), '');
});
