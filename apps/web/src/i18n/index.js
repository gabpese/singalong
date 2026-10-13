// Idiomas da interface: o português (Brasil) é a referência; inglês e espanhol traduzem as mesmas chaves.
// Trocar de idioma guarda a escolha e recarrega a página (as telas leem o texto uma vez, ao desenhar).
import en from './en.js';
import es from './es.js';
import pt from './pt.js';

export const LANGUAGES = { 'pt-BR': 'Português', en: 'English', es: 'Español' };
const CATALOGS = { 'pt-BR': pt, en, es };
const DEFAULT_LANGUAGE = 'pt-BR';
const KEY = 'lang';

/** O idioma a usar: o escolhido pela pessoa; senão o do navegador; senão o português. */
export function pickLanguage(saved, browser) {
  if (saved && saved in LANGUAGES) return saved;
  for (const tag of browser ?? []) {
    const base = String(tag).toLowerCase().split('-')[0];
    if (base === 'pt') return 'pt-BR';
    if (base === 'es') return 'es';
    if (base === 'en') return 'en';
  }
  return DEFAULT_LANGUAGE;
}

function read() {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null; // sem armazenamento (ou fora do navegador)
  }
}

let current = pickLanguage(read(), typeof document === 'undefined' ? [] : navigator.languages ?? [navigator.language]);
if (typeof document !== 'undefined') document.documentElement.lang = current;

export const getLanguage = () => current;

/** Escolhe o idioma e recarrega a página para valer em todas as telas. */
export function setLanguage(language) {
  if (!(language in LANGUAGES) || language === current) return;
  try {
    localStorage.setItem(KEY, language);
  } catch {
    // sem armazenamento: vale só até recarregar
  }
  if (typeof location !== 'undefined') location.reload();
  else current = language;
}

/** Texto de uma chave, com `{nome}` trocado pelos valores. Sem tradução, cai no português; sem nada, devolve a chave. */
export function translate(language, key, vars) {
  const text = CATALOGS[language]?.[key] ?? pt[key] ?? key;
  return vars ? text.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match)) : text;
}

/** Existe tradução para esta chave (no idioma atual ou no português)? */
export const hasText = (key) => key in (CATALOGS[current] ?? {}) || key in pt;

export const t = (key, vars) => translate(current, key, vars);
