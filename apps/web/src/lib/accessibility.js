// Tamanho da letra (para quem lê de longe ou enxerga pouco): um fator que multiplica o tamanho de todas as linhas da letra,
// guardado neste navegador. A TV, o palco e a aba TV da sala usam o mesmo valor.

export const LYRICS_SCALES = [0.8, 1, 1.25, 1.5, 1.8];
const KEY = 'lyricsScale';

/** O fator seguinte (`direction` = 1) ou anterior (-1) da lista; nos extremos, fica onde está. */
export function stepScale(current, direction) {
  const index = LYRICS_SCALES.reduce((best, value, i) => (Math.abs(value - current) < Math.abs(LYRICS_SCALES[best] - current) ? i : best), 0);
  return LYRICS_SCALES[Math.min(Math.max(index + direction, 0), LYRICS_SCALES.length - 1)];
}

export function getLyricsScale() {
  try {
    const saved = Number(localStorage.getItem(KEY));
    return LYRICS_SCALES.includes(saved) ? saved : 1;
  } catch {
    return 1; // sem armazenamento (ou fora do navegador)
  }
}

/** Aplica o fator à página (variável CSS `--lyrics-scale`) e o guarda. */
export function setLyricsScale(value) {
  if (typeof document !== 'undefined') document.documentElement.style.setProperty('--lyrics-scale', String(value));
  try {
    localStorage.setItem(KEY, String(value));
  } catch {
    // sem armazenamento: vale só até recarregar
  }
}

/** Aumenta (+1) ou diminui (-1) a letra e devolve o novo fator. */
export function changeLyricsScale(direction) {
  const next = stepScale(getLyricsScale(), direction);
  setLyricsScale(next);
  return next;
}

// ao carregar a página, aplica o que a pessoa escolheu antes
if (typeof document !== 'undefined') document.documentElement.style.setProperty('--lyrics-scale', String(getLyricsScale()));
