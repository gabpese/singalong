// The logo: "singalong" in two inks and, beside it, the "AO VIVO" sign from studio doors (worn, but working: it flickers gently).
// It only goes where the sign stays legible (from about 56 px of letter height); at small sizes the mark is used (/brand/mark.svg).
import { t } from '../i18n/index.ts';

export function Logo({ onPaper = false }: { onPaper?: boolean }) {
  const letters = [...t('brand.live')];
  const flicker = Math.min(3, letters.length - 1); // one letter fails more than the others
  return (
    <span className={`logo${onPaper ? ' on-paper' : ''}`}>
      <span className="logo-word">singalong</span>
      <span className="logo-sign" aria-hidden="true">
        {letters.map((letter, index) => (
          <span key={index} className={index === flicker ? 'flick' : undefined}>
            {letter}
          </span>
        ))}
      </span>
    </span>
  );
}
