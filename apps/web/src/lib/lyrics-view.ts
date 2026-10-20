// Drawing the synced lyrics (previous line, current line with filled words, next lines and the long-pause notice). It does not
// know where the clock comes from: the TV passes the audio's time; the phone's Stage, that of a clock synced with the TV.
import { t as translate } from '../i18n/index.ts';
import { splitParts, type Part } from './duet.ts';
import { gapDisplay, lineProgress, locate, wordFills, wordProgress, wordSpans, type WordSpan } from './lyrics-sync.ts';
import type { LyricCue } from './types.ts';

/** The elements where the lyrics are drawn. */
export interface LyricsElements {
  prev: HTMLElement;
  current: HTMLElement;
  next: HTMLElement;
  next2: HTMLElement;
}

export interface LyricsView {
  /** Replaces the lyrics and clears the screen. */
  setCues(next: readonly LyricCue[] | null | undefined): void;
  /**
   * Turns Duet mode on or back to normal. `chosen` is the split chosen by the singers (text of a b * -); without it (or if it
   * does not match the lyrics) the lines split between the two by themselves.
   */
  setDuet(on: boolean, chosen?: string | null): void;
  setOffset(seconds: number): void;
  clear(): void;
  /** Draws what holds at instant `time` (seconds) of the song. */
  render(time: number): void;
  readonly cues: readonly LyricCue[];
  readonly offset: number;
}

/** Sets (or removes) the line's owner: without an owner the attribute GOES (an empty one would still match the Duet's CSS). */
function mark(el: HTMLElement, part: Part | '') {
  if (part) el.dataset.part = part;
  else el.removeAttribute('data-part');
}

export function createLyricsView(els: LyricsElements): LyricsView {
  let cues: readonly LyricCue[] = [];
  let duet = false; // Duet: each line has an owner (a, b or both) and takes their color
  let assigned: string | null = null; // the split chosen by the singers (text of a b * -); null = automatic
  let parts: (Part | null)[] = [];
  let offset = 0;
  let lastKey = '';
  let words: { el: HTMLSpanElement; span: WordSpan; p: number }[] = []; // the current line's words
  let gapEl: HTMLSpanElement | null = null; // the long-pause notice, while it is on screen
  let lastDashes = -1;

  function clear() {
    for (const el of [els.prev, els.current, els.next, els.next2]) el.textContent = '';
    words = [];
    lastKey = '';
  }

  /** Builds the current line with one <span> per word (each with its own fill: the line break does not matter). */
  function buildCurrentLine(text: string) {
    els.current.textContent = '';
    words = wordSpans(text).map((span, i) => {
      const el = document.createElement('span');
      el.className = 'w';
      el.textContent = span.word;
      if (i) els.current.append(' ');
      els.current.append(el);
      return { el, span, p: -1 };
    });
  }

  function paintCurrentLine(lineP: number, fills: number[] | null) {
    words.forEach((w, i) => {
      const p = Math.round((fills ? fills[i] : wordProgress(w.span, lineP)) * 1000) / 10;
      if (p !== w.p) {
        w.p = p;
        w.el.style.setProperty('--p', `${p}%`);
      }
    });
  }

  /** A long pause in the lyrics: in place of the current line, "--------------" that vanishes in the last 8 s (get ready!). */
  function buildGapLine() {
    els.current.textContent = '';
    gapEl = document.createElement('span');
    gapEl.className = 'gap-dashes';
    els.current.append(gapEl);
    words = [];
    lastDashes = -1;
  }

  /**
   * Fits the lyrics in the card: if the lines do not fit the height (a phrase that wraps onto three lines, a small screen), it
   * shrinks the fonts step by step (`--fit`) instead of letting one line run over another.
   */
  function fit() {
    const box = els.current.parentElement;
    if (!box) return;
    let scale = 1;
    box.style.setProperty('--fit', '1');
    while (box.scrollHeight > box.clientHeight + 1 && scale > 0.4) {
      scale = Math.round((scale - 0.06) * 100) / 100;
      box.style.setProperty('--fit', String(scale));
    }
  }

  function paintGap(dashes: number) {
    if (dashes === lastDashes || !gapEl) return;
    lastDashes = dashes;
    gapEl.textContent = '-'.repeat(dashes);
  }

  return {
    setCues(next) {
      cues = Array.isArray(next) ? next : [];
      parts = duet ? splitParts(cues, assigned) : [];
      clear();
    },

    setDuet(on, chosen = null) {
      const next = Boolean(on);
      const text = next && typeof chosen === 'string' ? chosen : null;
      if (next === duet && text === assigned) return; // nothing changed: do not redo the split on every Room state
      duet = next;
      assigned = text;
      parts = duet ? splitParts(cues, assigned) : [];
      lastKey = '';
    },

    setOffset(seconds) {
      offset = Number(seconds) || 0;
    },

    clear() {
      cues = [];
      clear();
    },

    render(time) {
      const t = time + offset;
      const gap = gapDisplay(cues, t);
      let { current, next } = locate(cues, t);
      if (gap) {
        current = -1; // inside a long pause no line is being sung, even if the previous line's `end` says otherwise
        next = gap.next;
      }
      const text = (i: number) => cues[i]?.text ?? '';
      const anchor = current >= 0 ? current : next;
      const key = `${current}|${anchor}|${gap ? 'gap' : ''}`;
      if (key !== lastKey) {
        lastKey = key;
        els.prev.textContent = text(anchor - 1);
        if (gap) buildGapLine();
        else buildCurrentLine(current >= 0 ? text(current) : cues.length ? '' : translate('lyrics.none'));
        els.next.textContent = text(current >= 0 ? current + 1 : next);
        els.next2.textContent = text(current >= 0 ? current + 2 : next + 1);
        // Duet: who sings each line (the CSS paints it green, red or yellow); outside a Duet the attribute goes
        const part = (i: number): Part | '' => (duet && cues[i] ? parts[i] ?? '' : '');
        mark(els.prev, part(anchor - 1));
        mark(els.current, gap ? '' : part(current));
        mark(els.next, part(current >= 0 ? current + 1 : next));
        mark(els.next2, part(current >= 0 ? current + 2 : next + 1));
        fit();
      }
      if (gap) paintGap(gap.dashes);
      else paintCurrentLine(current >= 0 ? lineProgress(cues[current], t) : 0, current >= 0 ? wordFills(cues[current], words.length, t) : null);
    },

    get cues() {
      return cues;
    },

    get offset() {
      return offset;
    },
  };
}
