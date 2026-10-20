// Lyrics size (for whoever reads from afar or sees little): a factor that multiplies the size of every lyrics line, kept in
// this browser. The TV, the Stage and the Room's TV tab use the same value.

export const LYRICS_SCALES = [0.8, 1, 1.25, 1.5, 1.8];
const KEY = 'lyricsScale';

/** The next (`direction` = 1) or previous (-1) factor in the list; at either end, it stays where it is. */
export function stepScale(current: number, direction: number): number {
  const index = LYRICS_SCALES.reduce((best, value, i) => (Math.abs(value - current) < Math.abs(LYRICS_SCALES[best] - current) ? i : best), 0);
  return LYRICS_SCALES[Math.min(Math.max(index + direction, 0), LYRICS_SCALES.length - 1)];
}

export function getLyricsScale(): number {
  try {
    const saved = Number(localStorage.getItem(KEY));
    return LYRICS_SCALES.includes(saved) ? saved : 1;
  } catch {
    return 1; // no storage (or outside a browser)
  }
}

/** Applies the factor to the page (CSS variable `--lyrics-scale`) and keeps it. */
export function setLyricsScale(value: number): void {
  if (typeof document !== 'undefined') document.documentElement.style.setProperty('--lyrics-scale', String(value));
  try {
    localStorage.setItem(KEY, String(value));
  } catch {
    // no storage: it only lasts until a reload
  }
}

/** Makes the lyrics bigger (+1) or smaller (-1) and returns the new factor. */
export function changeLyricsScale(direction: number): number {
  const next = stepScale(getLyricsScale(), direction);
  setLyricsScale(next);
  return next;
}

// when the page loads, apply what the person chose before
if (typeof document !== 'undefined') document.documentElement.style.setProperty('--lyrics-scale', String(getLyricsScale()));
