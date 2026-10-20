// The UI's languages: Portuguese (Brazil) is the reference; English and Spanish translate the same keys.
// Switching languages keeps the choice and reloads the page (the screens read the text once, when they draw).
import en from './en.ts';
import es from './es.ts';
import pt from './pt.ts';

export const LANGUAGES = { 'pt-BR': 'Português', en: 'English', es: 'Español' };
export type Language = keyof typeof LANGUAGES;

const CATALOGS: Record<Language, Record<string, string>> = { 'pt-BR': pt, en, es };
const REFERENCE: Record<string, string> = pt;
const DEFAULT_LANGUAGE: Language = 'pt-BR';
const KEY = 'lang';

const isLanguage = (value: unknown): value is Language => typeof value === 'string' && value in LANGUAGES;

/** The language to use: the one the person chose; otherwise the browser's; otherwise Portuguese. */
export function pickLanguage(saved: string | null | undefined, browser: readonly string[] | null | undefined): Language {
  if (saved && isLanguage(saved)) return saved;
  for (const tag of browser ?? []) {
    const base = String(tag).toLowerCase().split('-')[0];
    if (base === 'pt') return 'pt-BR';
    if (base === 'es') return 'es';
    if (base === 'en') return 'en';
  }
  return DEFAULT_LANGUAGE;
}

function read(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null; // no storage (or outside a browser)
  }
}

let current = pickLanguage(read(), typeof document === 'undefined' ? [] : navigator.languages ?? [navigator.language]);
if (typeof document !== 'undefined') document.documentElement.lang = current;

export const getLanguage = (): Language => current;

/** Chooses the language and reloads the page so it applies to every screen. */
export function setLanguage(language: string): void {
  if (!isLanguage(language) || language === current) return;
  try {
    localStorage.setItem(KEY, language);
  } catch {
    // no storage: it only lasts until a reload
  }
  if (typeof location !== 'undefined') location.reload();
  else current = language;
}

/** A key's text, with `{name}` replaced by the values. Without a translation it falls back to Portuguese; without anything, it returns the key. */
export function translate(language: string, key: string, vars?: Record<string, unknown>): string {
  const text = (isLanguage(language) ? CATALOGS[language][key] : undefined) ?? REFERENCE[key] ?? key;
  return vars ? text.replace(/\{(\w+)\}/g, (match, name: string) => (name in vars ? String(vars[name]) : match)) : text;
}

/** Is there a translation for this key (in the current language or in Portuguese)? */
export const hasText = (key: string): boolean => key in CATALOGS[current] || key in REFERENCE;

export const t = (key: string, vars?: Record<string, unknown>): string => translate(current, key, vars);
