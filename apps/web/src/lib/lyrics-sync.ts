// Pure lyrics-sync logic (no DOM), testable in Node.
import { t as translate } from '../i18n/index.ts';
import type { LyricCue } from './types.ts';

type Timed = Pick<LyricCue, 'start' | 'end'> & { text?: string };

export interface WordSpan {
  word: string;
  from: number;
  to: number;
}

/**
 * Finds the active line at time `t` (seconds). `cues` is sorted by `start`.
 * - current: index of the line sung now, or -1 (before the first line or in a gap)
 * - next: index of the next line to sing (or cues.length when there are no more)
 */
export function locate(cues: readonly Timed[], t: number): { current: number; next: number } {
  let lo = 0;
  let hi = cues.length; // first index with start > t
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) lo = mid + 1;
    else hi = mid;
  }
  const last = lo - 1;
  if (last >= 0 && t < cues[last].end) return { current: last, next: last + 1 };
  return { current: -1, next: lo };
}

/**
 * When the line finishes being SUNG. Lyrics timed only at the start (LRC) mark a line's end at the start of the next one,
 * which hides solos and pauses inside the previous line. A line clearly too long for its text (more than 1.5× the estimate
 * of ~0.12 s per letter + 2 s) is treated as sung within the estimate, followed by silence. Lines with a plausible length keep
 * their original `end`.
 */
export function sungEnd(cue: Timed): number {
  const estimate = Math.max(3, 0.12 * (cue.text ?? '').length + 2);
  return cue.end - cue.start > estimate * 1.5 ? cue.start + estimate : cue.end;
}

/** Progress (0..1) within the line, for the gradual fill of the text. */
export function lineProgress(cue: Timed, t: number): number {
  const span = sungEnd(cue) - cue.start;
  if (span <= 0) return t >= cue.start ? 1 : 0;
  return Math.min(Math.max((t - cue.start) / span, 0), 1);
}

export const MIN_GAP_SECONDS = 3; // the pause from which the singer gets the "get ready" notice
export const GAP_DASHES = 14; // the notice's length: "--------------"
export const COUNTDOWN_SECONDS = 8; // the dashes vanish during the last 8 s before the next line (or over the whole pause, if it is shorter)

/**
 * If `t` is in a lyrics pause of 3 s or more (intro, solo, bridge), returns the notice to show: the next line's index, the
 * seconds until it and how many dashes to show.
 * The dashes stay full and, in the last 8 s (or over the whole pause, if it is shorter than 8 s), they vanish: the singer sees
 * WHEN the line will start.
 * Returns null outside long pauses, after the last line (there is no "next") and with empty lyrics.
 */
export function gapDisplay(cues: readonly Timed[], t: number): { next: number; remaining: number; dashes: number } | null {
  if (!cues.length) return null;
  let lo = 0;
  let hi = cues.length; // first index with start > t: the next line
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) lo = mid + 1;
    else hi = mid;
  }
  if (lo >= cues.length) return null;
  const gapStart = lo === 0 ? 0 : sungEnd(cues[lo - 1]); // the intro counts from the start of the song
  const gapEnd = cues[lo].start;
  if (t < gapStart || gapEnd - gapStart < MIN_GAP_SECONDS) return null;
  const remaining = gapEnd - t;
  const countdown = Math.min(COUNTDOWN_SECONDS, gapEnd - gapStart); // a 3 s pause has a 3 s countdown, not 8
  const dashes = remaining >= countdown ? GAP_DASHES : Math.max(1, Math.ceil((GAP_DASHES * remaining) / countdown));
  return { next: lo, remaining, dashes };
}

/**
 * Splits the phrase into words and works out at which fraction (0..1) of the line each one starts and ends, in proportion to
 * the number of characters (spaces included). It allows filling in reading order, wherever the line breaks on screen.
 */
export function wordSpans(text: string): WordSpan[] {
  const total = text.length;
  if (!total) return [];
  const spans: WordSpan[] = [];
  for (const m of text.matchAll(/\S+/g)) {
    spans.push({ word: m[0], from: m.index / total, to: (m.index + m[0].length) / total });
  }
  return spans;
}

/** A word's progress (0..1) given the line's progress (0..1). */
export function wordProgress(span: WordSpan, lineP: number): number {
  const width = span.to - span.from;
  if (width <= 0) return lineP >= span.to ? 1 : 0;
  return Math.min(Math.max((lineP - span.from) / width, 0), 1);
}

/**
 * The progress (0..1) of each word of the line at instant `t`, using the alignment's real times (`cue.words`).
 * Returns null when the line has no per-word times (or the count does not match): then the estimate by length applies.
 */
export function wordFills(cue: Pick<LyricCue, 'words'> | null | undefined, wordCount: number, t: number): number[] | null {
  const times = cue?.words;
  if (!Array.isArray(times) || times.length !== wordCount) return null;
  return times.map(([s, e]) => (e > s ? Math.min(Math.max((t - s) / (e - s), 0), 1) : t >= e ? 1 : 0));
}

const LYRICS_SOURCES: Record<string, string> = {
  video: 'lyrics.src.video',
  lrclib: 'lyrics.src.lrclib',
  file: 'lyrics.src.file',
  align: 'lyrics.src.align',
  'lrclib+align': 'lyrics.src.lrclibAlign',
  none: 'lyrics.src.none',
};

/** A friendly text for meta.json's `lyrics_source` (e.g. "text+lrclib"). */
export function describeLyricsSource(source: string | null | undefined): string {
  if (!source) return translate('lyrics.src.unknown');
  if (source.startsWith('text+')) return translate(source.slice('text+'.length) === 'video' ? 'lyrics.src.textVideo' : 'lyrics.src.textWeb');
  return LYRICS_SOURCES[source] ? translate(LYRICS_SOURCES[source]) : source;
}

export const PITCH_MIN = -6;
export const PITCH_MAX = 6;

/** The backing vocals' level: an integer from 0 to 100 (%); invalid = 0 (off). */
export function clampBacking(level: unknown): number {
  const n = Math.round(Number(level));
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(n, 0), 100);
}

/** Limits the pitch to ±6 semitones (beyond that the audio degrades) and rounds it to an integer. */
export function clampPitch(semitones: unknown): number {
  const n = Math.round(Number(semitones));
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(n, PITCH_MIN), PITCH_MAX);
}
