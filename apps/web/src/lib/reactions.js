// Reações dos celulares (aplausos, fogo...) que sobem pela tela da TV. A lista é a mesma do servidor (api/src/reactions.js).

export const REACTIONS = [
  { kind: 'clap', glyph: '👏' },
  { kind: 'fire', glyph: '🔥' },
  { kind: 'heart', glyph: '❤️' },
  { kind: 'party', glyph: '🎉' },
  { kind: 'wow', glyph: '🤩' },
];

const GLYPHS = Object.fromEntries(REACTIONS.map((r) => [r.kind, r.glyph]));
export const glyphOf = (kind) => GLYPHS[kind] ?? '';

/** Quanto tempo uma reação fica subindo na tela e quantas cabem ao mesmo tempo (a TV não vira uma nuvem de emojis). */
export const REACTION_LIFETIME_MS = 3200;
export const MAX_FLOATING = 30;

/** Adiciona uma reação à lista das que estão na tela, descartando as mais antigas acima do limite. */
export function addFloating(items, item, max = MAX_FLOATING) {
  return [...items, item].slice(-max);
}
