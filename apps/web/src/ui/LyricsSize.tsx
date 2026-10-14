// Botões A− e A+ para o tamanho da letra (TV, palco e aba TV da sala).
import { useState } from 'react';
import { t } from '../i18n/index.js';
import { changeLyricsScale, getLyricsScale, LYRICS_SCALES } from '../lib/accessibility.js';

export function LyricsSize() {
  const [scale, setScale] = useState(getLyricsScale);
  const change = (direction: number) => setScale(changeLyricsScale(direction));
  return (
    <span className="lyrics-size" role="group" aria-label={t('a11y.lyricsSize')}>
      <button type="button" aria-label={t('a11y.lyricsSmaller')} title={t('a11y.lyricsSmaller')} disabled={scale <= LYRICS_SCALES[0]} onClick={() => change(-1)}>
        A−
      </button>
      <button type="button" aria-label={t('a11y.lyricsBigger')} title={t('a11y.lyricsBigger')} disabled={scale >= LYRICS_SCALES[LYRICS_SCALES.length - 1]} onClick={() => change(1)}>
        A+
      </button>
    </span>
  );
}
