// Seletor de idioma: três bandeiras pequenas (Brasil, Estados Unidos e Espanha); a escolha fica guardada neste navegador.
// As bandeiras são desenhos simplificados em SVG (emoji de bandeira não aparece no Windows). O nome do idioma vai no rótulo.
import type { ReactNode } from 'react';
import { getLanguage, LANGUAGES, setLanguage, t } from '../i18n/index.ts';

const STARS = Array.from({ length: 20 }, (_, i) => ({ cx: 1.3 + (i % 5) * 2.4, cy: 1.2 + Math.floor(i / 5) * 2.5 }));

const FLAGS: Record<string, ReactNode> = {
  'pt-BR': (
    <>
      <rect width="30" height="20" fill="#009739" />
      <path d="M15 2.2 27.4 10 15 17.8 2.6 10Z" fill="#fedd00" />
      <circle cx="15" cy="10" r="5" fill="#012169" />
      <path d="M10.2 8.9c3.2-.5 6.9.4 9.6 2.6" fill="none" stroke="#fff" strokeWidth=".9" />
    </>
  ),
  en: (
    <>
      <rect width="30" height="20" fill="#fff" />
      {Array.from({ length: 7 }, (_, i) => (
        <rect key={i} y={(i * 20) / 6.5} width="30" height={20 / 13} fill="#b22234" />
      ))}
      <rect width="12.5" height={(20 / 13) * 7} fill="#3c3b6e" />
      {STARS.map((star, i) => (
        <circle key={i} cx={star.cx} cy={star.cy} r=".42" fill="#fff" />
      ))}
    </>
  ),
  es: (
    <>
      <rect width="30" height="20" fill="#aa151b" />
      <rect y="5" width="30" height="10" fill="#f1bf00" />
    </>
  ),
};

export function LanguageSwitch() {
  const current = getLanguage();
  return (
    <div className="language-switch" role="group" aria-label={t('lang.label')}>
      {Object.entries(LANGUAGES).map(([code, name]) => (
        <button
          key={code}
          type="button"
          lang={code}
          className={code === current ? 'on' : undefined}
          aria-label={name}
          aria-pressed={code === current}
          title={name}
          onClick={() => setLanguage(code)}
        >
          <svg viewBox="0 0 30 20" aria-hidden="true">
            {FLAGS[code]}
          </svg>
        </button>
      ))}
    </div>
  );
}
