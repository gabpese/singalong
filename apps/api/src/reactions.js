// Reações dos celulares (aplausos, fogo...) que aparecem na TV: só as da lista, com um limite por conexão para ninguém inundar a tela.

export const REACTION_KINDS = ['clap', 'fire', 'heart', 'party', 'wow'];

/**
 * Balde de fichas: começa cheio (`capacity` reações de uma vez) e enche `perSecond` por segundo. Cada reação gasta uma ficha;
 * sem ficha, a reação é descartada em silêncio (quem aperta sem parar não derruba nada).
 */
export function createBucket({ capacity = 6, perSecond = 3 } = {}) {
  let tokens = capacity;
  let last = null;
  return {
    take(nowMs) {
      if (last !== null) tokens = Math.min(capacity, tokens + ((nowMs - last) / 1000) * perSecond);
      last = nowMs;
      if (tokens < 1) return false;
      tokens -= 1;
      return true;
    },
  };
}
