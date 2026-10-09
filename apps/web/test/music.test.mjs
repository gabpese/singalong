import assert from 'node:assert/strict';
import test from 'node:test';
import { isUncertain, keyLabel, keySummary, transposeKey } from '../public/music.js';

const a = { tonic: 9, mode: 'minor', margin: 0.2 }; // o modo existe nos dados, mas não aparece na tela

test('keyLabel: só a nota, em solfejo e em cifra, sem maior/menor', () => {
  assert.equal(keyLabel(a), 'Lá (A)');
  assert.equal(keyLabel({ tonic: 0, mode: 'major' }), 'Dó (C)');
  assert.equal(keyLabel({ tonic: 11, mode: 'minor' }), 'Si (B)');
  assert.equal(keyLabel({ tonic: 1, mode: 'major' }), 'Dó♯ / Ré♭ (C#/Db)'); // acidentes mostram os dois nomes
  assert.equal(keyLabel({ tonic: 6, mode: 'minor' }), 'Fá♯ / Sol♭ (F#/Gb)');
  assert.equal(keyLabel({ tonic: 10, mode: 'minor' }), 'Lá♯ / Si♭ (A#/Bb)');
  assert.equal(keyLabel(null), '');
  // o mesmo nome para maior e menor: o modo não interfere
  assert.equal(keyLabel({ tonic: 3, mode: 'major' }), keyLabel({ tonic: 3, mode: 'minor' }));
});

test('as 12 notas têm nome único e nenhuma menciona maior/menor', () => {
  const labels = new Set();
  for (let tonic = 0; tonic < 12; tonic++) {
    const label = keyLabel({ tonic, mode: 'major' });
    assert.match(label, /^(Dó|Ré|Mi|Fá|Sol|Lá|Si)[♯♭]?( \/ (Dó|Ré|Mi|Fá|Sol|Lá|Si)[♯♭])? \([A-G]#?b?(\/[A-G]#?b?)?\)$/);
    assert.doesNotMatch(label, /maior|menor/);
    labels.add(label);
  }
  assert.equal(labels.size, 12);
});

test('transposeKey: soma semitons e dá a volta na oitava', () => {
  assert.equal(transposeKey(a, 2).tonic, 11); // Lá +2 = Si
  assert.equal(transposeKey(a, 3).tonic, 0); // dá a volta
  assert.equal(transposeKey(a, -9).tonic, 0);
  assert.equal(transposeKey(a, -6).tonic, 3);
  assert.equal(transposeKey({ tonic: 0, mode: 'major' }, -1).tonic, 11);
  assert.equal(transposeKey(null, 2), null);
  assert.equal(a.tonic, 9); // não altera o original
});

test('transposeKey também move a tonalidade alternativa', () => {
  const moved = transposeKey({ tonic: 5, mode: 'major', margin: 0.04, alt: { tonic: 2, mode: 'minor' } }, 2);
  assert.deepEqual([moved.tonic, moved.alt.tonic], [7, 4]);
});

test('isUncertain: margem pequena E notas diferentes entre a 1ª e a 2ª tonalidade', () => {
  assert.equal(isUncertain({ tonic: 0, mode: 'major', margin: 0.01 }), true); // sem alternativa informada
  assert.equal(isUncertain({ tonic: 5, mode: 'major', margin: 0.079, alt: { tonic: 2, mode: 'minor' } }), true);
  assert.equal(isUncertain({ tonic: 5, mode: 'major', margin: 0.2, alt: { tonic: 2, mode: 'minor' } }), false);
  assert.equal(isUncertain({ tonic: 0, mode: 'major' }), false); // sem margem informada
  // a alternativa tem a MESMA nota (só muda o modo): não há dúvida sobre a nota
  assert.equal(isUncertain({ tonic: 0, mode: 'major', margin: 0.01, alt: { tonic: 0, mode: 'minor' } }), false);
  assert.equal(isUncertain(null), false);
});

test('keySummary: a nota original e a nota cantada quando há transposição', () => {
  assert.equal(keySummary(a, 0), 'Tom: Lá (A)');
  assert.equal(keySummary(a, 2), 'Tom: Lá (A) → Si (B) com +2');
  assert.equal(keySummary(a, -3), 'Tom: Lá (A) → Fá♯ / Sol♭ (F#/Gb) com -3');
  assert.equal(keySummary({ tonic: 0, mode: 'major', margin: 0.01 }, 0), 'Tom provável: Dó (C)'); // sem alternativa
  const ambiguous = { tonic: 5, mode: 'major', margin: 0.04, alt: { tonic: 2, mode: 'minor' } };
  assert.equal(keySummary(ambiguous, 0), 'Tom provável: Fá (F) ou Ré (D)');
  assert.equal(keySummary(ambiguous, 2), 'Tom provável: Fá (F) ou Ré (D) → Sol (G) ou Mi (E) com +2');
  const sameNote = { tonic: 0, mode: 'major', margin: 0.01, alt: { tonic: 0, mode: 'minor' } };
  assert.equal(keySummary(sameNote, 0), 'Tom: Dó (C)'); // a nota é certa
  assert.equal(keySummary(null, 2), '');
});
