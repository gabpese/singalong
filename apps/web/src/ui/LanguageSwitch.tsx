// Seletor de idioma (a escolha fica guardada neste navegador).
import { getLanguage, LANGUAGES, setLanguage, t } from '../i18n/index.js';

export function LanguageSwitch() {
  return (
    <select className="language-switch" aria-label={t('lang.label')} value={getLanguage()} onChange={(event) => setLanguage(event.target.value)}>
      {Object.entries(LANGUAGES).map(([code, name]) => (
        <option key={code} value={code}>
          {name}
        </option>
      ))}
    </select>
  );
}
