// Tom da música como a pessoa lê: só a nota ("Lá (A)"), sem maior/menor, e quanto muda ao transpor.
// `key` vem do worker: { tonic: 0..11 (0 = Dó), mode, margin?, alt? }. O modo não é mostrado: ao subir ou descer o tom
// ele não muda, e a nota é o que a pessoa precisa para escolher em que tom cantar.

// notas com a grafia dos dois nomes quando têm acidente (a mesma tecla pode ser sustenido ou bemol)
const NOTES = [
  'Dó (C)',
  'Dó♯ / Ré♭ (C#/Db)',
  'Ré (D)',
  'Ré♯ / Mi♭ (D#/Eb)',
  'Mi (E)',
  'Fá (F)',
  'Fá♯ / Sol♭ (F#/Gb)',
  'Sol (G)',
  'Sol♯ / Lá♭ (G#/Ab)',
  'Lá (A)',
  'Lá♯ / Si♭ (A#/Bb)',
  'Si (B)',
];

/**
 * Margem (correlação da 1ª tonalidade menos a da 2ª) abaixo da qual não dá para ter certeza (ex.: Dó maior x Lá menor,
 * que usam as mesmas notas, mas têm tônicas diferentes). Valor empírico: nas músicas testadas, as de margem < 0,08 foram
 * as que mudaram de tonalidade de forma incoerente ao serem transpostas; as de margem maior acertaram todas as vezes.
 */
export const UNCERTAIN_MARGIN = 0.08;

const wrap = (tonic) => ((tonic % 12) + 12) % 12;

/** A nota do tom: "Lá (A)", "Dó♯ / Ré♭ (C#/Db)". */
export function keyLabel(key) {
  return key ? NOTES[wrap(key.tonic)] : '';
}

/** O mesmo tom subido/descido `semitones` semitons (a nota que a pessoa realmente canta). */
export function transposeKey(key, semitones) {
  if (!key) return null;
  return { ...key, tonic: wrap(key.tonic + semitones), alt: key.alt ? { ...key.alt, tonic: wrap(key.alt.tonic + semitones) } : undefined };
}

/**
 * A estimativa não separa bem a melhor tonalidade da segunda colocada, e elas têm NOTAS diferentes?
 * (Dó maior x Dó menor têm a mesma nota: não há dúvida sobre a nota; Fá maior x Ré menor, sim.)
 */
export function isUncertain(key) {
  return Boolean(key)
    && typeof key.margin === 'number'
    && key.margin < UNCERTAIN_MARGIN
    && (!key.alt || key.alt.tonic !== key.tonic);
}

/** "Lá (A)" ou, quando a estimativa é incerta, "Fá (F) ou Ré (D)". */
function keyOptions(key) {
  return isUncertain(key) && key.alt ? `${keyLabel(key)} ou ${keyLabel(key.alt)}` : keyLabel(key);
}

/**
 * Texto do tom de uma música na fila: o original e, se houver transposição, o tom cantado.
 * Ex.: "Tom: Lá (A)" · "Tom: Lá (A) → Si (B) com +2" · "Tom provável: Fá (F) ou Ré (D)".
 */
export function keySummary(key, pitch = 0) {
  if (!key) return '';
  const original = `${isUncertain(key) ? 'Tom provável' : 'Tom'}: ${keyOptions(key)}`;
  if (!pitch) return original;
  return `${original} → ${keyOptions(transposeKey(key, pitch))} com ${pitch > 0 ? '+' : ''}${pitch}`;
}
