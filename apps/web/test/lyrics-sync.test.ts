import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clampBacking, clampPitch, COUNTDOWN_SECONDS, describeLyricsSource, GAP_DASHES, gapDisplay, lineProgress, locate, MIN_GAP_SECONDS, sungEnd, wordProgress, wordSpans,
} from '../src/lib/lyrics-sync.ts';

const cues = [
  { start: 10, end: 12, text: 'a' },
  { start: 12, end: 14, text: 'b' },
  { start: 20, end: 25, text: 'c' },
];

/** The gap notice at `t`, which the test expects to be showing. */
const gapAt = (lines: Parameters<typeof gapDisplay>[0], t: number) => {
  const gap = gapDisplay(lines, t);
  assert.ok(gap, `a notice at ${t} s`);
  return gap;
};

test('locate: before the first line', () => {
  assert.deepEqual(locate(cues, 0), { current: -1, next: 0 });
  assert.deepEqual(locate(cues, 9.99), { current: -1, next: 0 });
});

test('locate: inside a line and on the border', () => {
  assert.deepEqual(locate(cues, 10), { current: 0, next: 1 });
  assert.deepEqual(locate(cues, 11.9), { current: 0, next: 1 });
  assert.deepEqual(locate(cues, 12), { current: 1, next: 2 }); // the end is exclusive, the start inclusive
});

test('locate: the gap between lines and after the last one', () => {
  assert.deepEqual(locate(cues, 16), { current: -1, next: 2 });
  assert.deepEqual(locate(cues, 24.9), { current: 2, next: 3 });
  assert.deepEqual(locate(cues, 99), { current: -1, next: 3 });
});

test('locate: empty lyrics', () => {
  assert.deepEqual(locate([], 5), { current: -1, next: 0 });
});

test('lineProgress', () => {
  assert.equal(lineProgress(cues[0], 10), 0);
  assert.equal(lineProgress(cues[0], 11), 0.5);
  assert.equal(lineProgress(cues[0], 50), 1);
  assert.equal(lineProgress({ start: 5, end: 5 }, 4), 0);
  assert.equal(lineProgress({ start: 5, end: 5 }, 6), 1);
});

test('clampPitch', () => {
  assert.equal(clampPitch(3.4), 3);
  assert.equal(clampPitch('-9'), -6);
  assert.equal(clampPitch(100), 6);
  assert.equal(clampPitch('abc'), 0);
});

test('wordSpans: growing fractions that cover the sentence', () => {
  const spans = wordSpans('Lock me up');
  assert.deepEqual(spans.map((s) => s.word), ['Lock', 'me', 'up']);
  assert.equal(spans[0].from, 0);
  assert.equal(spans.at(-1)?.to, 1);
  for (let i = 1; i < spans.length; i++) assert.ok(spans[i].from >= spans[i - 1].to);
  assert.deepEqual(wordSpans(''), []);
});

test('wordProgress: fills in reading order, regardless of line breaks', () => {
  const spans = wordSpans('Lock me up and close the door when it rains');
  const at = (lineP: number) => spans.map((s) => wordProgress(s, lineP));
  assert.ok(at(0).every((p) => p === 0));
  assert.ok(at(1).every((p) => p === 1));
  const half = at(0.5);
  // a later word is never more filled than an earlier one
  for (let i = 1; i < half.length; i++) assert.ok(half[i] <= half[i - 1], `word ${i}`);
  assert.equal(half[0], 1); // the start is full
  assert.equal(half.at(-1), 0); // the last one is still empty ("rains" does not fill along with the start)
});

test('describeLyricsSource: no jargon on screen', () => {
  assert.equal(describeLyricsSource('none'), 'sem letra (só o instrumental)');
  assert.equal(describeLyricsSource('lrclib'), 'buscada na internet');
  assert.equal(describeLyricsSource('video'), 'legenda do vídeo');
  assert.equal(describeLyricsSource('align'), 'seu texto, no ritmo da voz');
  assert.equal(describeLyricsSource('lrclib+align'), 'buscada na internet, no ritmo da voz');
  assert.equal(describeLyricsSource('text+lrclib'), 'seu texto, com os tempos da busca na internet');
  assert.equal(describeLyricsSource('text+video'), 'seu texto, com os tempos da legenda do vídeo');
  assert.equal(describeLyricsSource(undefined), 'desconhecida');
});

// ---------- long pauses: the "--------------" notice ----------

const song = [
  { start: 12, end: 16, text: 'the first line of a song' }, // a 12 s intro
  { start: 17, end: 21, text: 'the next line' }, // a short pause (1 s)
  { start: 40, end: 44, text: 'after the solo' }, // a 19 s solo
  { start: 44.5, end: 48, text: 'last refrain' },
];

test('sungEnd: keeps the end of lines whose length is plausible for their text', () => {
  assert.equal(sungEnd({ start: 10, end: 14, text: 'a line of lyrics' }), 14); // 4 s for 16 characters (an estimate of 3.9 s)
  assert.equal(sungEnd({ start: 10, end: 15.5, text: 'a line of lyrics' }), 15.5); // up to 1.5× the estimate still holds
  assert.equal(sungEnd({ start: 0, end: 4 }), 4); // no text: it does not break, it uses the 3 s minimum
});

test('sungEnd: a line too long for its text is treated as sung within the estimate', () => {
  const hidden = { start: 100, end: 117.7, text: 'x'.repeat(45) }; // 17.7 s for 45 characters: a solo hides inside
  assert.ok(Math.abs(sungEnd(hidden) - (100 + 0.12 * 45 + 2)) < 1e-9);
  assert.ok(Math.abs(sungEnd({ start: 10, end: 16, text: 'abcdefghij' }) - 13.2) < 1e-9); // 6 s for 10 characters: past 1.5 × 3.2
  assert.ok(sungEnd({ start: 0, end: 60, text: 'hi' }) < 10); // a 3 s minimum estimate
});

test('gapDisplay: the intro (≥ 3 s) shows all 14 dashes', () => {
  const g = gapAt(song, 2);
  assert.equal(g.next, 0);
  assert.equal(g.dashes, GAP_DASHES);
  assert.equal(g.dashes, 14);
  assert.ok(Math.abs(g.remaining - 10) < 1e-9);
});

test('gapDisplay: in the last 8 s the dashes fade until the line starts', () => {
  assert.equal(gapAt(song, 12 - COUNTDOWN_SECONDS - 0.5).dashes, 14); // still outside the countdown
  assert.equal(gapAt(song, 12 - 4).dashes, 7); // 4 s of 8 left: half
  assert.equal(gapAt(song, 12 - 2).dashes, 4); // 2 s left: ceil(14 × 2/8)
  assert.equal(gapAt(song, 12 - 0.1).dashes, 1); // almost time: still 1 dash
  assert.equal(gapDisplay(song, 12), null); // the line started
  const seen: number[] = [];
  for (let t = 4; t < 12; t += 0.5) seen.push(gapAt(song, t).dashes);
  assert.deepEqual(seen, [...seen].sort((a, b) => b - a)); // never grows
});

test('gapDisplay: short pauses show no notice', () => {
  assert.equal(gapDisplay(song, 18), null); // inside line 2
  assert.equal(gapDisplay(song, 16.5), null); // between lines 1 and 2: 1 s
  assert.equal(gapDisplay([{ start: 2.9, end: 10, text: 'a' }], 0), null); // a 2.9 s intro: too short
  assert.notEqual(gapDisplay([{ start: MIN_GAP_SECONDS, end: 12, text: 'a' }], 0), null); // exactly 3 s: it shows
  assert.equal(MIN_GAP_SECONDS, 3);
});

test("gapDisplay: a solo in the middle of the song (from the previous line's end)", () => {
  assert.equal(gapAt(song, 21.5).dashes, 14); // the 19 s pause began
  assert.equal(gapAt(song, 21.5).next, 2);
  assert.equal(gapAt(song, 36).dashes, 7); // 4 s left
  assert.equal(gapDisplay(song, 40.1), null);
});

test('gapDisplay: a solo hidden inside an LRC line that is too long', () => {
  const lrc = [
    { start: 10, end: 14, text: 'early' },
    { start: 14, end: 31.7, text: 'x'.repeat(45) }, // the LRC does not mark the solo: the line "lasts" 17.7 s
    { start: 31.7, end: 36, text: 'ending' },
  ];
  assert.equal(gapDisplay(lrc, 15), null); // still singing the line
  const inSolo = gapAt(lrc, 25); // past the estimated time (7.4 s): it is a pause
  assert.equal(inSolo.next, 2);
  assert.ok(inSolo.remaining > 6 && inSolo.remaining < 7);
  assert.equal(gapDisplay(lrc, 32), null);
});

test('gapDisplay: no notice after the last line, nor with empty lyrics', () => {
  assert.equal(gapDisplay(song, 100), null);
  assert.equal(gapDisplay([], 3), null);
});

test('lineProgress uses the sung end: the fill does not drag through a solo', () => {
  const hidden = { start: 0, end: 20, text: 'x'.repeat(30) }; // estimate = 5.6 s
  assert.equal(lineProgress(hidden, 5.6), 1);
  assert.ok(lineProgress(hidden, 2.8) > 0.45 && lineProgress(hidden, 2.8) < 0.55);
});

test('clampBacking: the backing vocals level, an integer from 0 to 100; an invalid one turns them off', () => {
  assert.equal(clampBacking(40), 40);
  assert.equal(clampBacking(40.6), 41);
  assert.equal(clampBacking(-10), 0);
  assert.equal(clampBacking(250), 100);
  assert.equal(clampBacking('55'), 55);
  assert.equal(clampBacking('a lot'), 0);
  assert.equal(clampBacking(undefined), 0);
  assert.equal(clampBacking(null), 0);
});

test('gapDisplay: a short pause (3 s to 8 s) has full dashes at its start and fades along all of it', () => {
  const lines = [{ start: 0, end: 2, text: 'the first line we sing' }, { start: 9, end: 11, text: 'the next line' }]; // the pause runs from the 1st line's estimated end (~5.2 s) to 9 s
  const gapStart = sungEnd(lines[0]);
  const length = 9 - gapStart;
  assert.ok(length >= MIN_GAP_SECONDS && length < COUNTDOWN_SECONDS, `a pause of ${length} s`);
  assert.equal(gapAt(lines, gapStart + 0.01).dashes, 14); // at the pause's start: full (not already half)
  const middle = gapAt(lines, gapStart + length / 2).dashes;
  assert.ok(middle > 1 && middle < 14, `in the middle: ${middle}`);
  assert.equal(gapAt(lines, 9 - 0.05).dashes, 1);
  const seen: number[] = [];
  for (let t = gapStart + 0.01; t < 9; t += 0.25) seen.push(gapAt(lines, t).dashes);
  assert.deepEqual(seen, [...seen].sort((a, b) => b - a)); // never grows
});
