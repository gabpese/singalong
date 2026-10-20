import { t } from '../i18n/index.ts';

// Duet: who sings each lyrics line. For now the split is AUTOMATIC; the design leaves room to grow (for example, a split chosen
// by hand by the singers, which would replace this function's result).

/** Each line's part: 'a' (the singer who added the song), 'b' (the guest) or 'both' (the two together). */
export type Part = 'a' | 'b' | 'both';

export const PARTS: Part[] = ['a', 'b', 'both'];

/** A line's text without capitals, punctuation or repeated spaces: "Oh, oh!" and "oh oh" are the same line. */
const normalize = (text: unknown) => String(text ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Very short lines ("oh", "yeah") repeat in any song and do not point to a chorus. */
const MIN_CHORUS_CHARS = 8;

/**
 * Splits the lyrics between the two singers:
 *  - lines that REPEAT (the chorus) are sung by both ('both');
 *  - the others alternate, one line per singer (a, b, a, b...), starting with whoever added the song;
 *  - empty lines have no part (null) and do not count in the alternation.
 * If the singers chose the split (`assigned`, text of a b * -) and it matches the lyrics, it wins.
 * Returns an array as long as `cues`.
 */
export function splitParts(cues: readonly ({ text?: string } | null | undefined)[] | null | undefined, assigned: string | null = null): (Part | null)[] {
  const chosen = decodeParts(assigned, cues?.length ?? 0);
  if (chosen) return chosen;
  const keys = (cues ?? []).map((cue) => normalize(cue?.text));
  const counts = new Map<string, number>();
  for (const key of keys) if (key.length >= MIN_CHORUS_CHARS) counts.set(key, (counts.get(key) ?? 0) + 1);
  let turn = 0;
  return keys.map((key) => {
    if (!key) return null;
    if ((counts.get(key) ?? 0) > 1) return 'both';
    return turn++ % 2 === 0 ? 'a' : 'b';
  });
}

const PART_BY_CHAR: Record<string, Part | null> = { a: 'a', b: 'b', '*': 'both', '-': null };
const CHAR_BY_PART: Record<string, string> = { a: 'a', b: 'b', both: '*' };

/**
 * The split chosen by the singers (text with `a`, `b`, `*` = both and `-` = nobody, one letter per lyrics line) as the list of
 * parts. If it does not exist, does not match the lyrics' length (the lyrics changed) or has odd letters: null, and the
 * automatic split wins.
 */
export function decodeParts(text: unknown, lines: number): (Part | null)[] | null {
  if (typeof text !== 'string' || text.length !== lines || !/^[ab*-]+$/.test(text)) return null;
  return [...text].map((char) => PART_BY_CHAR[char]);
}

/** The list of parts ('a' | 'b' | 'both' | null) as the text the server keeps. */
export const encodeParts = (parts: readonly (Part | null)[]): string => parts.map((part) => CHAR_BY_PART[String(part)] ?? '-').join('');

/** The part singing at instant `t` (s): that of the lyrics line on air ('a', 'b' or 'both'), or null between lines. */
export function partAtTime(cues: readonly { start: number; end: number }[] | null | undefined, parts: readonly (Part | null)[], t: number): Part | null {
  const index = (cues ?? []).findIndex((cue) => cue.start <= t && t < cue.end);
  return index < 0 ? null : parts[index] ?? null;
}

/** Does singer `me` ('a' or 'b') sing at instant `t`? (lines "together" count for both) */
export function singsAt(cues: readonly { start: number; end: number }[] | null | undefined, parts: readonly (Part | null)[], t: number, me: 'a' | 'b'): boolean {
  const part = partAtTime(cues, parts, t);
  return part === me || part === 'both';
}

/** Which is my part on the Stage? Whoever added the song is 'a' (turquoise, circle); the guest, 'b' (violet, square). */
export const myPart = (item: { guest_me?: boolean } | null | undefined): 'a' | 'b' => (item?.guest_me ? 'b' : 'a');

export const partName = (part: Part): string => t(`duet.part.${part}`);
