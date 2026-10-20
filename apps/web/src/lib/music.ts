// A song's key as the person reads it: only the note ("Lá (A)"), without major or minor, and how much it changes when
// transposed. `key` comes from the worker: { tonic: 0..11 (0 = C), mode, margin?, alt? }. The mode is not shown: it does not
// change when the key goes up or down, and the note is what the person needs to choose the key to sing in.
import { t } from '../i18n/index.ts';
import type { SongKey } from './types.ts';

/**
 * The margin (the best key's correlation minus the second's) below which we cannot be sure (e.g. C major vs A minor, which
 * use the same notes but have different tonics). Empirical value: in the songs tested, those with a margin < 0.08 were the
 * ones whose key changed incoherently when transposed; those with a larger margin were right every time.
 */
export const UNCERTAIN_MARGIN = 0.08;

const wrap = (tonic: number) => ((tonic % 12) + 12) % 12;

/** The key's note: "Lá (A)", "Dó♯ / Ré♭ (C#/Db)". */
export function keyLabel(key: Pick<SongKey, 'tonic'> | null | undefined): string {
  return key ? t(`note.${wrap(key.tonic)}`) : '';
}

/** The same key moved up or down by `semitones` semitones (the note the person actually sings). */
export function transposeKey(key: SongKey | null | undefined, semitones: number): SongKey | null {
  if (!key) return null;
  return { ...key, tonic: wrap(key.tonic + semitones), alt: key.alt ? { ...key.alt, tonic: wrap(key.alt.tonic + semitones) } : undefined };
}

/**
 * Does the estimate fail to separate the best key from the runner-up, while they have different NOTES?
 * (C major vs C minor share the note: there is no doubt about it; F major vs D minor do not.)
 */
export function isUncertain(key: SongKey | null | undefined): boolean {
  return Boolean(key)
    && typeof key?.margin === 'number'
    && key.margin < UNCERTAIN_MARGIN
    && (!key.alt || key.alt.tonic !== key.tonic);
}

/** "Lá (A)" or, when the estimate is uncertain, "Fá (F) ou Ré (D)". */
function keyOptions(key: SongKey | null): string {
  return key && isUncertain(key) && key.alt ? t('key.or', { a: keyLabel(key), b: keyLabel(key.alt) }) : keyLabel(key);
}

/**
 * The key text of a song in the queue: the original and, when transposed, the key that is sung.
 * E.g. "Tom: Lá (A)" · "Tom: Lá (A) → Si (B) com +2" · "Tom provável: Fá (F) ou Ré (D)".
 */
export function keySummary(key: SongKey | null | undefined, pitch = 0): string {
  if (!key) return '';
  const original = t(isUncertain(key) ? 'key.likely' : 'key.original', { notes: keyOptions(key) });
  if (!pitch) return original;
  return t('key.shifted', { original, notes: keyOptions(transposeKey(key, pitch)), shift: `${pitch > 0 ? '+' : ''}${pitch}` });
}

/** The note the person sings with the song at `pitch`: "Si (B)" or, when the estimate is uncertain, "Fá (F) ou Ré (D)". */
export function noteSummary(key: SongKey | null | undefined, pitch = 0): string {
  return key ? keyOptions(transposeKey(key, pitch)) : '';
}

/** The pitch adjustment in words, without a bare number: "Tom original", "Mais agudo (+2)", "Mais grave (−1)". */
export function pitchLabel(pitch: number): string {
  if (!pitch) return t('pitch.original');
  return `${t(pitch > 0 ? 'pitch.higher' : 'pitch.lower')} (${pitch > 0 ? '+' : '−'}${Math.abs(pitch)})`;
}
