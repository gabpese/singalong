// Scoring by pitch: compares the pitch picked up by the microphone with the original voice's melody (the worker's melody.json).

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/** The worker's melody: one MIDI note per `hop` seconds, -1 where the original voice is silent. */
export interface Melody {
  hop: number;
  midi: number[];
}

/** One readable row per block, for `console.table` at the end of the song. */
export interface BlockReport {
  span: string;
  original: string;
  main: string;
  sung: string;
  distance: number | null;
  accuracy: number;
  readings: string;
  participation: number;
}

export interface Scorer {
  /** t = the song's position (s); captured = MIDI note picked up by the microphone (or null: silence). Returns the live score (0..100) or null. */
  tick(t: number, captured: number | null | undefined): number | null;
  /** The key can change in the middle of the song: the reference melody follows. */
  setTranspose(semitones: number): void;
  /** A score of 0..100 (null while no frame has been scored). */
  score(): number | null;
  /** Every block scored so far, in order. */
  report(): BlockReport[];
  readonly reference: number | null;
  /** The sung note that counts in the current block, with its octave (MIDI). */
  readonly sung: number | null;
  readonly evaluated: number;
}

/** "A4" for MIDI note 69 (or "—" without a note). */
export const noteName = (midi: number | null | undefined): string =>
  midi == null || midi < 0 ? '—' : `${NAMES[((Math.round(midi) % 12) + 12) % 12]}${Math.floor(Math.round(midi) / 12) - 1}`;

export const hzToMidi = (hz: number): number => 69 + 12 * Math.log2(hz / 440);

/** The volume (RMS) of a block of audio. */
export function rms(buf: ArrayLike<number>): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

/**
 * The fundamental frequency (Hz) of a block of audio by the YIN method, or null without a clear pitch.
 * The block needs at least 2 periods of the lowest pitch (2048 samples cover 70 Hz at 48 kHz).
 */
export function detectPitch(
  buf: ArrayLike<number>,
  sampleRate: number,
  { minHz = 70, maxHz = 1000, threshold = 0.15 }: { minHz?: number; maxHz?: number; threshold?: number } = {},
): number | null {
  const half = buf.length >> 1;
  const tauMin = Math.max(2, Math.floor(sampleRate / maxHz));
  const tauMax = Math.min(Math.floor(sampleRate / minHz), half - 1);
  if (tauMax <= tauMin) return null;
  const cmnd = new Float32Array(tauMax + 1);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    let d = 0;
    for (let i = 0; i < half; i++) {
      const delta = buf[i] - buf[i + tau];
      d += delta * delta;
    }
    running += d;
    cmnd[tau] = running ? (d * tau) / running : 1;
  }
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (cmnd[tau] >= threshold) continue;
    while (tau + 1 <= tauMax && cmnd[tau + 1] < cmnd[tau]) tau++; // go down to the local minimum
    const a = cmnd[tau - 1];
    const b = cmnd[tau];
    const c = cmnd[tau + 1] ?? b;
    const denom = a - 2 * b + c;
    const shift = denom ? (a - c) / (2 * denom) : 0; // parabolic interpolation: better than one-sample precision
    return sampleRate / (tau + shift);
  }
  return null;
}

/** The distance in semitones between two notes, ignoring the octave (whoever sings an octave above or below is also right). */
export function pitchClassDistance(a: number, b: number): number {
  const d = (((a - b) % 12) + 12) % 12;
  return Math.min(d, 12 - d);
}

// Credit by the distance (in semitones, ignoring the octave) between the sung note and the original's main one: it falls
// gradually, because 2 or 3 semitones off is still "almost" for a human voice (vibrato, slides, an imprecise note).
const CREDIT_BY_DISTANCE = [1, 1, 0.8, 0.5]; // 0, 1, 2 and 3 semitones; more than that scores nothing
const creditFor = (distance: number) => CREDIT_BY_DISTANCE[distance] ?? 0;
const BLOCK_SECONDS = 2; // the note is checked once every 2 s: the original melody changes several times a second and nobody follows every change
const MAIN_SHARE = 0.4; // notes the original holds for at least 40% of the block are its "main" ones
const MIN_REF_FRAMES = 10; // a block with less than 0.5 s of voice in the original is not graded
// The pitch detector fails on many frames of a real voice (consonants, breathing, a weak voice). So the score separates "was
// singing?" (frames with a detected pitch) from "was in tune?" (the block's most sung note): detecting in 40% of the voiced
// frames is already full participation, and the detector's failure does not become the singer's mistake.
const PARTICIPATION_FULL = 0.4;
const HOLD_SECONDS = 0.15; // the detector fails on consonants and breaths: the last note picked up less than 150 ms ago counts

const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
};

/**
 * Turns the raw melody (which wavers several frames a second: vibrato, slides, detector errors) into stable notes: a median of
 * ±2 frames, then continuous stretches of notes within 1 semitone of each other become a single note (their median), and
 * stretches shorter than `minFrames` frames (0.3 s) are absorbed by the nearest neighbour.
 */
export function smoothMelody(midi: readonly number[], { minFrames = 6 }: { minFrames?: number } = {}): number[] {
  const n = midi.length;
  const filtered = midi.map((m, i) => {
    if (m < 0) return -1;
    const near: number[] = [];
    for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) if (midi[j] >= 0) near.push(midi[j]);
    return median(near);
  });
  // stretches of continuous voice, split when the note moves more than 1 semitone from the stretch's median
  const segments: { from: number; to: number; note: number }[] = []; // `to` is exclusive
  let i = 0;
  while (i < n) {
    if (filtered[i] < 0) { i++; continue; }
    let j = i;
    const seen = [filtered[i]];
    while (j + 1 < n && filtered[j + 1] >= 0 && Math.abs(filtered[j + 1] - median(seen)) <= 1) seen.push(filtered[++j]);
    segments.push({ from: i, to: j + 1, note: median(seen) });
    i = j + 1;
  }
  // stretches that are too short join the touching neighbour with the nearest note (or vanish if they stand alone)
  const result: number[] = new Array(n).fill(-1);
  segments.forEach((seg, k) => {
    let note = seg.note;
    if (seg.to - seg.from < minFrames) {
      const near = [segments[k - 1], segments[k + 1]].filter((o) => o && (o.to === seg.from || o.from === seg.to) && o.to - o.from >= minFrames);
      if (!near.length) return;
      note = near.reduce((a, b) => (Math.abs(a.note - seg.note) <= Math.abs(b.note - seg.note) ? a : b)).note;
    }
    result.fill(note, seg.from, seg.to);
  });
  return result;
}

const pitchClass = (midiNote: number) => ((Math.round(midiNote) % 12) + 12) % 12;
const mostFrequent = (counts: Map<number, number>): number | null =>
  [...counts].reduce<[number, number] | null>((best, entry) => (!best || entry[1] > best[1] ? entry : best), null)?.[0] ?? null;

/** The note's name without the octave ("A" for 69, 57, 81...). */
export const classNameOf = (pc: number | null | undefined): string => (pc == null ? '—' : NAMES[pc]);

interface Block {
  /** Readings with voice in the original. */
  n: number;
  /** Readings with a detected pitch. */
  heard: number;
  /** Pitch class (0..11) -> readings. */
  hist: Map<number, number>;
  /** Whole MIDI note -> readings. */
  notes: Map<number, number>;
}

interface Reference {
  /** The original's most frequent note in the block. */
  display: number;
  /** The block's main pitch classes. */
  classes: number[];
}

/**
 * Scores the song in 2 s blocks; `transpose` = the chosen key (semitones).
 * In each block it checks ONE note: the one the singer sang most against the main notes the original holds in it, ignoring the
 * octave. `include(t)` (optional, Duet): only the instants when this singer sings count. `onBlock(row)` is called when a block
 * ends (debugging). Only the frames where the original voice sings count; frames already scored (seek) do not count twice.
 */
export function createScorer(
  melody: Melody,
  { transpose = 0, onBlock = null, include = null }: { transpose?: number; onBlock?: ((row: BlockReport) => void) | null; include?: ((t: number) => boolean) | null } = {},
): Scorer {
  const { hop } = melody;
  const midi = smoothMelody(melody.midi); // the reference is the stable melody, not the raw one
  const blockFrames = Math.round(BLOCK_SECONDS / hop);
  let shift = transpose;
  const seen = new Uint8Array(midi.length);
  const blocks = new Map<number, Block>();
  const refCache = new Map<number, Reference | null>();
  let counted = 0;
  let heldNote: number | null = null;
  let heldAt = -Infinity;
  let reference: number | null = null; // the current block's reference note, already in the chosen key
  let sungNow: number | null = null; // the note the singer sang most in the current block
  let lastBlock: number | null = null;

  /** The sung note that counts in the block, with its octave: the most frequent within the most sung pitch class. */
  function sungNoteOf({ hist, notes }: Block): number | null {
    const pc = mostFrequent(hist);
    if (pc == null) return null;
    return mostFrequent(new Map([...notes].filter(([note]) => pitchClass(note) === pc)));
  }

  function refOf(block: number): Reference | null {
    if (refCache.has(block)) return refCache.get(block) ?? null;
    const notes = new Map<number, number>();
    const classes = new Map<number, number>();
    let voiced = 0;
    for (let i = block * blockFrames; i < Math.min(midi.length, (block + 1) * blockFrames); i++) {
      if (midi[i] < 0) continue;
      voiced++;
      notes.set(midi[i], (notes.get(midi[i]) ?? 0) + 1);
      classes.set(pitchClass(midi[i]), (classes.get(pitchClass(midi[i])) ?? 0) + 1);
    }
    const info = voiced < MIN_REF_FRAMES ? null : {
      display: mostFrequent(notes) as number, // the block has voiced frames, so it has a most frequent note
      // no note reaches the share (the original goes through several): the most frequent one counts
      classes: [...classes].filter(([, count]) => count >= voiced * MAIN_SHARE || count === Math.max(...classes.values())).map(([pc]) => pc),
    };
    refCache.set(block, info);
    return info;
  }

  const clock = (seconds: number) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

  /** One block's comparison: what the original holds, what was sung and how many points it gave. */
  function evaluate(block: number) {
    const data = blocks.get(block) as Block; // only called for blocks already scored
    const { n, heard, hist } = data;
    const ref = refOf(block);
    const sungClass = mostFrequent(hist);
    let dist: number | null = null;
    let accuracy = 0;
    let participation = 0;
    if (heard && ref && sungClass !== null) {
      dist = Math.min(...ref.classes.map((pc) => pitchClassDistance(sungClass, pc + shift)));
      accuracy = creditFor(dist);
      participation = Math.min(1, heard / n / PARTICIPATION_FULL);
    }
    return { n, heard, ref, sungClass, sungNote: sungNoteOf(data), dist, accuracy, participation, points: n * participation * accuracy };
  }

  /** A readable row per block (span, original note, sung note, result). */
  function explain(block: number): BlockReport {
    const { n, heard, ref, sungNote, dist, accuracy, participation } = evaluate(block);
    return {
      span: `${clock(block * BLOCK_SECONDS)}–${clock((block + 1) * BLOCK_SECONDS)}`,
      original: ref ? noteName(ref.display + shift) : '—',
      main: ref ? ref.classes.map((pc) => classNameOf((pc + shift + 120) % 12)).join('/') : '',
      sung: heard ? noteName(sungNote) : '—',
      distance: dist,
      accuracy,
      readings: `${heard}/${n}`,
      participation: Math.round(participation * 100) / 100,
    };
  }

  return {
    tick(t, captured) {
      if (captured != null) {
        heldNote = captured;
        heldAt = t;
      }
      const sung = captured ?? (t - heldAt <= HOLD_SECONDS && t >= heldAt ? heldNote : null);
      const idx = Math.floor(t / hop);
      const block = Math.floor(idx / blockFrames);
      if (onBlock && lastBlock !== null && block !== lastBlock && blocks.has(lastBlock)) onBlock(explain(lastBlock));
      lastBlock = block;
      const ref = idx >= 0 && idx < midi.length ? refOf(block) : null;
      reference = ref ? ref.display + shift : null;
      const current = blocks.get(block);
      sungNow = current ? sungNoteOf(current) : null;
      if (!ref || midi[idx] < 0 || seen[idx] || (include && !include(t))) return this.score();
      seen[idx] = 1;
      counted++;
      const blk = current ?? { n: 0, heard: 0, hist: new Map<number, number>(), notes: new Map<number, number>() };
      blocks.set(block, blk);
      blk.n++;
      if (sung != null) {
        blk.heard++;
        blk.hist.set(pitchClass(sung), (blk.hist.get(pitchClass(sung)) ?? 0) + 1);
        blk.notes.set(Math.round(sung), (blk.notes.get(Math.round(sung)) ?? 0) + 1);
        sungNow = sungNoteOf(blk);
      }
      return this.score();
    },
    setTranspose(semitones) { shift = semitones; },
    score() {
      let total = 0;
      let points = 0;
      for (const [block, data] of blocks) {
        total += data.n;
        points += evaluate(block).points;
      }
      return total ? Math.round((100 * points) / total) : null;
    },
    report: () => [...blocks.keys()].sort((a, b) => a - b).map(explain),
    get reference() { return reference; },
    get sung() { return sungNow; },
    get evaluated() { return counted; },
  };
}

export interface OpenMic {
  /** `midi` = the note picked up (null: silence or no clear pitch). */
  read(): { midi: number | null; level: number };
  stop(): void;
}

/** Opens the microphone. Throws if the person denies access. */
export async function openMic(deviceId = ''): Promise<OpenMic> {
  const stream = await navigator.mediaDevices.getUserMedia({
    // echo cancellation keeps the TV's own instrumental from counting as voice; the chosen device is "ideal" (falls back to the default if it left)
    audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false, ...(deviceId ? { deviceId: { ideal: deviceId } } : {}) },
  });
  const ctx = new AudioContext();
  await ctx.resume();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  return {
    read() {
      analyser.getFloatTimeDomainData(buf);
      const level = rms(buf);
      if (level < 0.005) return { midi: null, level }; // silence
      const hz = detectPitch(buf, ctx.sampleRate);
      return { midi: hz ? hzToMidi(hz) : null, level };
    },
    stop() {
      for (const track of stream.getTracks()) track.stop();
      ctx.close();
    },
  };
}
