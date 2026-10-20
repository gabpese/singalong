// Texts and display calculations for the queue (pure, no DOM).
import { t } from '../i18n/index.ts';
import type { SongView } from './types.ts';

const STAGES = ['downloading', 'separating', 'lyrics', 'aligning', 'retrying'];

export type ChipKind = 'ok' | 'busy' | 'warn' | 'error';

interface QueueState<T extends { id: number }> {
  queue?: T[];
  current_item_id?: number | null;
  next_item_id?: number | null;
  play_order?: number[];
}

interface Named {
  artist?: string | null;
  title?: string | null;
  video_title?: string | null;
}

/** Is "Try again" worth offering? Not when the error is final (private, blocked or too long video...). */
export function canRetry(song: Pick<SongView, 'status' | 'retry'> | null | undefined): boolean {
  return song?.status === 'failed' && song.retry !== 'never';
}

/** The label of a song's state in the queue. */
export function songChip(song: Pick<SongView, 'status' | 'stage' | 'ready'> | null | undefined): { label: string; kind: ChipKind } {
  if (!song) return { label: t('chip.waiting'), kind: 'busy' };
  if (song.status === 'needs_lyrics') return { label: t('chip.needsLyrics'), kind: 'warn' };
  if (song.status === 'failed') return { label: t('chip.failed'), kind: 'error' };
  if (song.status === 'pending') return { label: t('chip.pending'), kind: 'busy' };
  if (song.status === 'processing') return { label: song.stage && STAGES.includes(song.stage) ? t(`stage.${song.stage}`) : t('chip.processing'), kind: 'busy' };
  if (song.ready) return { label: t('chip.ready'), kind: 'ok' };
  return { label: t('chip.waiting'), kind: 'busy' };
}

export function formatDuration(seconds: number | null | undefined): string {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const thumbnailUrl = (videoId: string): string => `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;

/** The percentage (0..100) played; 0 when the duration is unknown. */
export function progressPercent(positionMs: number, durationSeconds: number | null | undefined): number {
  if (!durationSeconds) return 0;
  return Math.min(100, Math.max(0, (positionMs / 1000 / durationSeconds) * 100));
}

/** "+3", "-2" or "0": the pitch as the person reads it. */
export function formatPitch(semitones: number): string {
  return semitones > 0 ? `+${semitones}` : String(semitones);
}

/**
 * Who sings next: the item the server chose (ready, following the fair rotation); if none is ready, the first in the waiting
 * queue, marked as "still preparing".
 */
export function nextUp<T extends { id: number }>(state: QueueState<T> | null | undefined): { item: T; preparing: boolean } | null {
  const { waiting } = splitQueue(state);
  const chosen = waiting.find((item) => item.id === state?.next_item_id);
  if (chosen) return { item: chosen, preparing: false };
  return waiting.length ? { item: waiting[0], preparing: true } : null;
}

/**
 * What plays and what comes next, IN THE ORDER IT WILL PLAY: the next one the server chose (ready, following the fair rotation)
 * goes first; the rest follow the queue's order.
 */
export function playOrder<T extends { id: number }>(state: QueueState<T> | null | undefined): { current: T | null; upcoming: T[] } {
  const { current, waiting } = splitQueue(state);
  if (Array.isArray(state?.play_order)) {
    const byId = new Map(waiting.map((item) => [item.id, item]));
    const ordered = state.play_order.map((id) => byId.get(id)).filter((item): item is T => Boolean(item));
    return { current, upcoming: [...ordered, ...waiting.filter((item) => !ordered.includes(item))] };
  }
  const next = waiting.find((item) => item.id === state?.next_item_id);
  return { current, upcoming: next ? [next, ...waiting.filter((item) => item !== next)] : waiting };
}

/** The item playing and the ones waiting, from the Room's state. */
export function splitQueue<T extends { id: number }>(state: QueueState<T> | null | undefined): { current: T | null; waiting: T[] } {
  const current = state?.queue?.find((item) => item.id === state.current_item_id) ?? null;
  return { current, waiting: (state?.queue ?? []).filter((item) => item.id !== current?.id) };
}

/** Lowercase and without accents: "Ré", "RE" and "re" are the same thing for whoever is searching. */
export function normalizeText(value: unknown): string {
  return String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Filters the songs already prepared by artist and name. Each typed word must appear in one of the two, in any order
 * ("elfman jack" finds "Jack's Lament — Danny Elfman"). An empty query returns everything.
 */
export function filterSongs<T extends Named>(songs: T[], query: string): T[] {
  const terms = normalizeText(query).split(' ').filter(Boolean);
  if (!terms.length) return songs;
  return songs.filter((song) => {
    const haystack = normalizeText(`${song.artist ?? ''} ${song.title ?? ''} ${song.video_title ?? ''}`);
    return terms.every((term) => haystack.includes(term));
  });
}

/** A text's words for comparing versions: without accents, capitals, apostrophes or punctuation ("Don't Stop!" -> dont, stop). */
function words(value: unknown): string[] {
  return normalizeText(value).replace(/['’`]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Songs already ready (the Jukebox) that are the one the person is asking for: ALL the words of the typed artist and name
 * appear, whole, in the artist, the title or the YouTube VIDEO'S ORIGINAL TITLE (`video_title`): whoever gave the song another
 * name when asking for it still finds it by what the video is called ("Faouzia - Unethical (MAPHRA Vocal Cover)" is found by
 * Maphra + Unethical). One of the two fields is enough (only the artist or only the name); with neither, nothing is suggested.
 */
export function findJukeboxMatches<T extends Named>(songs: T[], artist: unknown, title: unknown): T[] {
  const wanted = [...new Set([...words(artist), ...words(title)])];
  if (!wanted.length) return [];
  return sortSongs(
    songs.filter((song) => {
      const have = new Set([...words(song.artist), ...words(song.title), ...words(song.video_title)]);
      return wanted.every((word) => have.has(word));
    }),
  );
}

/** Alphabetical order by artist and then by name; those without an artist go last (also in alphabetical order). */
export function sortSongs<T extends Named>(songs: readonly T[]): T[] {
  const collator = new Intl.Collator('pt-BR', { sensitivity: 'base' });
  return [...songs].sort((a, b) => {
    const artistA = normalizeText(a.artist);
    const artistB = normalizeText(b.artist);
    if (artistA !== artistB && (!artistA || !artistB)) return artistA ? -1 : 1; // whoever has no artist goes last
    return collator.compare(artistA, artistB) || collator.compare(normalizeText(a.title), normalizeText(b.title));
  });
}
