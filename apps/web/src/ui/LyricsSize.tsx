// The A− and A+ buttons for the lyrics' size (TV, Stage and the Room's TV tab).
import { useState } from 'react';
import { t } from '../i18n/index.ts';
import { changeLyricsScale, getLyricsScale, LYRICS_SCALES } from '../lib/accessibility.ts';

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
