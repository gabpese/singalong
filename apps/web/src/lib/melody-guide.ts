// The melody guide on the TV: the original voice's notes as bars moving left, with the singer's pitch on top.
// Only the part without drawing lives here (notes, time window, vertical scale, octave and hits), to test in Node.
import { pitchClassDistance, smoothMelody, type Melody } from './scoring.ts';

/** How much of the song is on screen: a little of what passed and plenty of what is coming (so the person can get ready). */
export const SECONDS_BEFORE = 2;
export const SECONDS_AFTER = 6;
/** The vertical range shows at least one octave; `PAD` semitones of room above and below the notes. */
const MIN_SPAN = 12;
const PAD = 2;
/** Up to how many semitones away (ignoring the octave) the sung note still counts as "in tune". */
export const GOOD_DISTANCE = 1;
/** The colors of the Duet's parts in the guide (the same as the lyrics: turquoise, violet and, together, the theme's yellow). */
export const PART_COLORS = { a: '#10B8C8', b: '#8B5CF6' };

/** How long the trail of what was sung stays on screen (s). */
export const TRAIL_SECONDS = 3;

/** Times in seconds; `note` is a whole MIDI note. */
export interface MelodyNote {
  start: number;
  end: number;
  note: number;
}

/** A vertical range, in MIDI notes. */
export interface PitchRange {
  low: number;
  high: number;
}

export interface Scale {
  x(t: number): number;
  y(note: number): number;
  barHeight: number;
  nowX: number;
}

/** The melody's stable notes: continuous stretches of the same note (the already smoothed melody, the same one scoring uses). */
export function melodyNotes(melody: Melody | null | undefined): MelodyNote[] {
  if (!melody?.hop || !Array.isArray(melody.midi)) return [];
  const midi = smoothMelody(melody.midi);
  const notes: MelodyNote[] = [];
  let i = 0;
  while (i < midi.length) {
    if (midi[i] < 0) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < midi.length && midi[j + 1] === midi[i]) j++;
    notes.push({ start: i * melody.hop, end: (j + 1) * melody.hop, note: midi[i] });
    i = j + 1;
  }
  return notes;
}

/** The notes that show (even partly) between `from` and `to` seconds. */
export function notesInWindow(notes: readonly MelodyNote[], from: number, to: number): MelodyNote[] {
  return notes.filter((n) => n.end > from && n.start < to);
}

/** The note (in the chosen key) that the original sings at instant `t`, or null. */
export function noteAt(notes: readonly MelodyNote[], t: number, transpose = 0): number | null {
  const found = notes.find((n) => n.start <= t && t < n.end);
  return found ? found.note + transpose : null;
}

/** The vertical range (MIDI) covering the window's notes, with room and at least one octave. */
export function pitchRange(visible: readonly MelodyNote[], transpose = 0): PitchRange | null {
  if (!visible.length) return null;
  let low = Infinity;
  let high = -Infinity;
  for (const n of visible) {
    low = Math.min(low, n.note + transpose);
    high = Math.max(high, n.note + transpose);
  }
  low -= PAD;
  high += PAD;
  if (high - low < MIN_SPAN) {
    const extra = (MIN_SPAN - (high - low)) / 2;
    low -= extra;
    high += extra;
  }
  return { low, high };
}

/** Eases the range from one frame to the next (the vertical scale does not jump when a high note enters the window). */
export function easeRange(current: PitchRange | null, target: PitchRange | null, factor = 0.08): PitchRange | null {
  if (!target) return current;
  if (!current) return target;
  return { low: current.low + (target.low - current.low) * factor, high: current.high + (target.high - current.high) * factor };
}

/** The sung note in the octave nearest the reference's: whoever sings an octave above or below also shows next to the bar. */
export function foldToNearestOctave(sung: number, reference: number): number;
export function foldToNearestOctave(sung: number | null | undefined, reference: number | null | undefined): number | null | undefined;
export function foldToNearestOctave(sung: number | null | undefined, reference: number | null | undefined): number | null | undefined {
  if (sung == null || reference == null) return sung;
  return sung + 12 * Math.round((reference - sung) / 12);
}

/** Did what was sung count as "in tune" for the reference note (ignoring the octave)? */
export function isGood(sung: number | null | undefined, reference: number | null | undefined): boolean {
  return sung != null && reference != null && pitchClassDistance(sung, reference) <= GOOD_DISTANCE;
}

/** Converts time to x and note to y in a `width` x `height` frame; "now" sits at 1/4 from the left. */
export function makeScale({ position, width, height, range }: { position: number; width: number; height: number; range: PitchRange | null }): Scale {
  const span = SECONDS_BEFORE + SECONDS_AFTER;
  const perSecond = width / span;
  const semitone = range ? height / (range.high - range.low) : 0;
  return {
    x: (t) => (t - position + SECONDS_BEFORE) * perSecond,
    y: (note) => (range ? height - (note - range.low) * semitone : height / 2),
    barHeight: Math.max(6, semitone * 0.8),
    nowX: SECONDS_BEFORE * perSecond,
  };
}

/** Adds a reading to the trail and drops what got too old (`t` in the song's seconds). */
export function pushTrail<T extends { t: number }>(trail: readonly T[], point: T, keepSeconds = TRAIL_SECONDS): T[] {
  const next = [...trail, point];
  const cut = point.t - keepSeconds;
  return next.filter((p) => p.t >= cut);
}
