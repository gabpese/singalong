// The local agent: paired devices, Sessions and who is "online".
//
// The owner installs the app on their computer (the "agent"), pairs it with this server through a one-time code and starts a
// SESSION. The Rooms created in the Session send their song requests to the agent of the Session's owner (and only to it).
// The cloud knows only a display nickname and whether the owner is online: never cookies, the e-mail or the YouTube account.
//
// This file holds the area's limits and plain helpers; the database work is in agent.service.ts, the routes in the controllers.
import { createHash, timingSafeEqual } from 'node:crypto';
import { HttpError } from '../rooms.js';

export const PAIR_CODE_LENGTH = 8;
export const PAIR_TTL_MS = 10 * 60 * 1000;
export const ONLINE_MS = 45_000; // no signal (heartbeat, claim, progress) for longer than this = the owner is offline
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000; // a Session without a signal for a day is ended (the app closed without saying so)
export const MAX_NAME = 30;

/** A song's identifier: YouTube's (11 characters) or an imported file's ("f-" + 12 hex digits). */
export const VIDEO_ID_PATTERN = '^([A-Za-z0-9_-]{11}|f-[0-9a-f]{12})$';
const VIDEO_ID = new RegExp(VIDEO_ID_PATTERN);
export const MAX_LIBRARY_BATCH = 100;
const MAX_META_BYTES = 20_000;

const PRIVATE_IPV4 = /^(127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)$/;

export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
export const clean = (text: unknown, max: number) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * The (http) address of the agent's local media server, which the BROWSER of everyone in the Room opens. Only the local machine
 * (localhost, 127.x) or a private network: a compromised agent cannot point the guests to just any site.
 * Returns the normalized address (no trailing slash) or null (no local server); throws 400 when invalid.
 */
export function normalizeMediaBase(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  const invalid = () => new HttpError(400, 'invalid_media_base', 'Endereço de mídia inválido: use http://127.0.0.1:porta/… ou um endereço da rede local.');
  let url: URL;
  try {
    url = new URL(String(value));
  } catch {
    throw invalid();
  }
  const hostOk = url.hostname === 'localhost' || url.hostname === '[::1]' || PRIVATE_IPV4.test(url.hostname);
  const path = url.pathname.replace(/\/+$/, '');
  if (url.protocol !== 'http:' || !hostOk || url.username || url.password || url.search || url.hash || !/^(\/[A-Za-z0-9_-]{1,64})?$/.test(path)) throw invalid();
  return `${url.protocol}//${url.host}${path}`;
}

/** The files the server uses of a song in an owner's catalog. */
export interface LibraryFiles {
  instrumental: boolean;
  lyrics: boolean;
  melody: boolean;
  backing: boolean;
  vocals: boolean;
  /** The keys that already have an MP4 on the owner's computer. */
  exports: number[];
}

/** Checks one catalog entry sent by the agent. */
export function checkLibraryEntry(entry: unknown): { videoId: string; meta: Record<string, unknown>; files: LibraryFiles } {
  const bad = (message: string) => new HttpError(400, 'invalid_library_entry', message);
  const given = entry as { id?: unknown; meta?: unknown; files?: unknown } | null;
  if (!given || typeof given !== 'object' || !VIDEO_ID.test(String(given.id))) throw bad('Identificador de música inválido.');
  if (!given.meta || typeof given.meta !== 'object' || Array.isArray(given.meta)) throw bad('meta inválido.');
  if (JSON.stringify(given.meta).length > MAX_META_BYTES) throw bad('meta grande demais.');
  const files = (given.files ?? {}) as Record<string, unknown>;
  if (typeof files !== 'object' || files === null || Array.isArray(files)) throw bad('files inválido.');
  const exports = Array.isArray(files.exports) ? files.exports.filter((pitch) => Number.isInteger(pitch) && pitch >= -6 && pitch <= 6) : [];
  return {
    videoId: String(given.id),
    meta: given.meta as Record<string, unknown>,
    // only what the server uses: the instrumental and the lyrics are required; the rest is optional
    files: { instrumental: files.instrumental === true, lyrics: files.lyrics === true, melody: files.melody === true, backing: files.backing === true, vocals: files.vocals === true, exports },
  };
}

/** Compares in constant time (the admin token must not leak through a timing difference). */
export function safeEqual(a: unknown, b: unknown): boolean {
  const x = Buffer.from(String(a ?? ''));
  const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && timingSafeEqual(x, y);
}
