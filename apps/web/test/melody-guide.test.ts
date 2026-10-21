import assert from 'node:assert/strict';
import test from 'node:test';
import { easeRange, foldToNearestOctave, isGood, makeScale, melodyNotes, noteAt, notesInWindow, pitchRange, pushTrail, SECONDS_AFTER, SECONDS_BEFORE } from '../src/lib/melody-guide.ts';

type Notes = Parameters<typeof pitchRange>[0];

/** A synthetic melody: a `hop` of 0.05 s; each stretch = [note | -1, frames]. */
function melody(parts: [number, number][], hop = 0.05) {
  const midi: number[] = [];
  for (const [note, frames] of parts) for (let i = 0; i < frames; i++) midi.push(note);
  return { hop, midi };
}

/** Notes with only their pitch (pitchRange reads nothing else). */
const pitches = (...notes: number[]) => notes.map((note) => ({ note })) as unknown as Notes;

test('melodyNotes: continuous stretches of the same note, with the right times, and the silence left out', () => {
  const notes = melodyNotes(melody([[-1, 10], [60, 20], [-1, 10], [64, 20]]));
  assert.equal(notes.length, 2);
  assert.deepEqual(notes.map((n) => n.note), [60, 64]);
  assert.ok(Math.abs(notes[0].start - 0.5) < 1e-9 && Math.abs(notes[0].end - 1.5) < 1e-9);
  assert.ok(Math.abs(notes[1].start - 2) < 1e-9 && Math.abs(notes[1].end - 3) < 1e-9);
  assert.deepEqual(melodyNotes(null), []);
  assert.deepEqual(melodyNotes({ hop: 0.05, midi: [] }), []);
});

test("notesInWindow and noteAt: only the window's notes; the note at an instant already in the chosen key", () => {
  const notes = melodyNotes(melody([[60, 20], [-1, 20], [67, 20]])); // 0–1 s, 2–3 s
  assert.deepEqual(notesInWindow(notes, 0.5, 2.5).map((n) => n.note), [60, 67]);
  assert.deepEqual(notesInWindow(notes, 1.2, 1.8), []);
  assert.equal(noteAt(notes, 0.5), 60);
  assert.equal(noteAt(notes, 0.5, 2), 62); // key +2
  assert.equal(noteAt(notes, 1.5), null); // a pause
  assert.equal(noteAt(notes, 2.5), 67);
});

test('pitchRange: covers the notes with room to spare and is never smaller than an octave; without notes there is no range', () => {
  const wide = pitchRange(pitches(55, 79));
  assert.deepEqual(wide, { low: 53, high: 81 });
  const narrow = pitchRange(pitches(60));
  assert.ok(narrow && narrow.high - narrow.low >= 12);
  assert.ok(narrow && narrow.low < 60 && narrow.high > 60);
  assert.deepEqual(pitchRange(pitches(60), 2), pitchRange(pitches(62))); // the chosen key shifts the range
  assert.equal(pitchRange([]), null);
});

test('easeRange: moves little by little to the new range and takes the first value', () => {
  assert.deepEqual(easeRange(null, { low: 50, high: 70 }), { low: 50, high: 70 });
  const step = easeRange({ low: 50, high: 70 }, { low: 60, high: 80 }, 0.5);
  assert.deepEqual(step, { low: 55, high: 75 });
  assert.deepEqual(easeRange({ low: 1, high: 2 }, null), { low: 1, high: 2 });
});

test('foldToNearestOctave and isGood: whoever sings an octave off shows next to the bar, and a hit ignores the octave', () => {
  assert.equal(foldToNearestOctave(48, 62), 60); // an octave below: it moves up near 62
  assert.equal(foldToNearestOctave(76, 62), 64);
  assert.equal(foldToNearestOctave(null, 62), null);
  assert.equal(foldToNearestOctave(60, null), 60);
  assert.equal(isGood(48, 60), true); // the same note, another octave
  assert.equal(isGood(61, 60), true); // a semitone still counts
  assert.equal(isGood(63, 60), false);
  assert.equal(isGood(null, 60), false);
});

test('makeScale: "now" sits at 1/4 from the left; the future to the right and the high notes on top', () => {
  const range = { low: 50, high: 74 };
  const scale = makeScale({ position: 10, width: 800, height: 240, range });
  assert.equal(scale.x(10), scale.nowX);
  assert.equal(scale.nowX, (SECONDS_BEFORE / (SECONDS_BEFORE + SECONDS_AFTER)) * 800);
  assert.equal(scale.x(10 + SECONDS_AFTER), 800);
  assert.equal(scale.x(10 - SECONDS_BEFORE), 0);
  assert.ok(scale.y(72) < scale.y(52)); // higher, further up (a smaller y)
  assert.equal(scale.y(50), 240);
  assert.equal(scale.y(74), 0);
  assert.ok(scale.barHeight >= 6);
  assert.equal(makeScale({ position: 0, width: 100, height: 100, range: null }).y(60), 50); // without a range: in the middle
});

test('pushTrail: keeps only the last seconds', () => {
  let trail: ReturnType<typeof pushTrail> = [];
  for (let t = 0; t <= 10; t += 0.5) {
    const point = { t, midi: 60 };
    trail = pushTrail(trail, point);
  }
  assert.ok(trail.length <= 7);
  assert.equal(trail[trail.length - 1].t, 10);
  assert.ok(trail[0].t >= 7);
});
