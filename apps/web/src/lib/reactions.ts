// Phone reactions (claps, fire...) that float up the TV screen. The list is the same as the server's (api/src/reactions.js).

import type { ReactionKind } from './types.ts';

export const REACTIONS: { kind: ReactionKind; glyph: string }[] = [
  { kind: 'clap', glyph: '👏' },
  { kind: 'fire', glyph: '🔥' },
  { kind: 'heart', glyph: '❤️' },
  { kind: 'party', glyph: '🎉' },
  { kind: 'wow', glyph: '🤩' },
];

const GLYPHS: Record<string, string> = Object.fromEntries(REACTIONS.map((r) => [r.kind, r.glyph]));
export const glyphOf = (kind: string): string => GLYPHS[kind] ?? '';

/** How long a reaction keeps floating on screen and how many fit at once (the TV does not turn into a cloud of emojis). */
export const REACTION_LIFETIME_MS = 3200;
export const MAX_FLOATING = 30;

/** Adds a reaction to the ones on screen, dropping the oldest above the limit. */
export function addFloating<T>(items: T[], item: T, max = MAX_FLOATING): T[] {
  return [...items, item].slice(-max);
}
