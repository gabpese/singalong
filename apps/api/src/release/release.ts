// The published app version: what the server tells the installed apps (the update notice) and the home page (the download
// button). A version published on the admin page wins; otherwise the APP_* variables from the .env apply.
import { compareVersions, parseVersion } from '../version.ts';

const NOTES_MAX = 500;
const URL_MAX = 500;

export interface ReleaseFields {
  latest: string;
  minimum: string;
  notes: string;
  url: string;
}

/** What applies now, with where it came from: `panel` (the admin page), `env` (APP_* variables) or `none` (nothing set). */
export interface PublishedRelease extends ReleaseFields {
  source: 'panel' | 'env' | 'none';
  updated_at: number | null;
}

/** A release the admin page refused, with the code and the message the page shows. */
export class ReleaseError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

/** Validates and trims what the admin page sends. */
export function cleanRelease(input: Partial<Record<keyof ReleaseFields, unknown>>): ReleaseFields {
  const text = (value: unknown) => String(value ?? '').trim();
  const latest = text(input.latest);
  const minimum = text(input.minimum);
  const notes = text(input.notes);
  const url = text(input.url);
  if (latest && !parseVersion(latest)) throw new ReleaseError('bad_version', 'A versão mais recente precisa ser como 1.2.3.');
  if (minimum && !parseVersion(minimum)) throw new ReleaseError('bad_version', 'A versão mínima precisa ser como 1.2.3.');
  if (latest && minimum && (compareVersions(minimum, latest) ?? 0) > 0) throw new ReleaseError('min_above_latest', 'A versão mínima não pode ser maior que a mais recente.');
  if (notes.length > NOTES_MAX) throw new ReleaseError('notes_too_long', `A mensagem pode ter até ${NOTES_MAX} caracteres.`);
  if (url && (url.length > URL_MAX || !/^https?:\/\/[^\s]+$/i.test(url))) throw new ReleaseError('bad_url', 'O endereço de download precisa começar com http:// ou https://.');
  return { latest, minimum, notes, url };
}
