// A versão do app publicada: o que o servidor diz aos apps instalados (aviso de atualização) e à página inicial (botão de baixar).
// Se o administrador publicou uma versão pelo painel, ela vale; senão valem as variáveis APP_* do .env.
import { compareVersions, parseVersion } from './version.js';

const NOTES_MAX = 500;
const URL_MAX = 500;

/** Valida e limpa o que o painel manda: devolve { latest, minimum, notes, url } ou lança um erro com `code` e `message`. */
export function cleanRelease(input) {
  const fail = (code, message) => Object.assign(new Error(message), { code });
  const text = (value) => String(value ?? '').trim();
  const latest = text(input.latest);
  const minimum = text(input.minimum);
  const notes = text(input.notes);
  const url = text(input.url);
  if (latest && !parseVersion(latest)) throw fail('bad_version', 'A versão mais recente precisa ser como 1.2.3.');
  if (minimum && !parseVersion(minimum)) throw fail('bad_version', 'A versão mínima precisa ser como 1.2.3.');
  if (latest && minimum && compareVersions(minimum, latest) > 0) throw fail('min_above_latest', 'A versão mínima não pode ser maior que a mais recente.');
  if (notes.length > NOTES_MAX) throw fail('notes_too_long', `A mensagem pode ter até ${NOTES_MAX} caracteres.`);
  if (url && (url.length > URL_MAX || !/^https?:\/\/[^\s]+$/i.test(url))) throw fail('bad_url', 'O endereço de download precisa começar com http:// ou https://.');
  return { latest, minimum, notes, url };
}

export function createRelease({ config, db, now = Date.now }) {
  const fromEnv = () => ({ latest: config.appLatestVersion ?? '', minimum: config.appMinVersion ?? '', notes: config.appNotes ?? '', url: config.appDownloadUrl ?? '' });
  return {
    /** O que vale agora, com a origem: `panel` (publicado no painel), `env` (variáveis APP_*) ou `none` (nada configurado). */
    get() {
      const saved = db.getRelease();
      if (saved) return { latest: saved.latest, minimum: saved.minimum, notes: saved.notes, url: saved.url, source: 'panel', updated_at: saved.updated_at };
      const env = fromEnv();
      const configured = Object.values(env).some(Boolean);
      return { ...env, source: configured ? 'env' : 'none', updated_at: null };
    },
    /** O que as variáveis do .env dizem (para o painel mostrar o que voltaria ao limpar). */
    env: fromEnv,
    set(input) {
      const clean = cleanRelease(input);
      db.setRelease(clean, now());
      return clean;
    },
    /** Volta a valer o .env. */
    clear: () => db.clearRelease(),
  };
}
