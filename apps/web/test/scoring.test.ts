import assert from 'node:assert/strict';
import test from 'node:test';
import { createScorer, detectPitch, hzToMidi, noteName, pitchClassDistance, rms, smoothMelody } from '../src/lib/scoring.ts';

type Options = Parameters<typeof createScorer>[1];

const sine = (hz: number, sampleRate = 48000, n = 2048, amp = 0.5) => Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / sampleRate));

test("detectPitch finds the pitch of voice-like sines (with an error under 1%)", () => {
  for (const hz of [110, 220, 440, 880]) {
    const found = detectPitch(sine(hz), 48000) ?? 0;
    assert.ok(Math.abs(found - hz) / hz < 0.01, `${hz} Hz -> ${found}`);
  }
  assert.ok(Math.abs(hzToMidi(detectPitch(sine(440), 48000) ?? 0) - 69) < 0.1);
});

test('detectPitch answers null for silence and noise', () => {
  assert.equal(detectPitch(new Float32Array(2048), 48000), null);
  const noise = Float32Array.from({ length: 2048 }, (_, i) => Math.sin(i * i * 12.9898) * 0.5);
  assert.equal(detectPitch(noise, 48000), null);
  assert.ok(rms(sine(440)) > 0.3);
});

test('pitchClassDistance ignores the octave and is circular', () => {
  assert.equal(pitchClassDistance(60, 72), 0);
  assert.equal(pitchClassDistance(60, 71), 1);
  assert.equal(pitchClassDistance(61, 66), 5);
  assert.equal(pitchClassDistance(60, 66), 6);
});

const hold = (note: number, frames: number): number[] => Array(frames).fill(note);
const FRAMES = 40; // a 2 s block has 40 frames of 50 ms

/** Runs the singer `sing(frame, originalNote)` through the whole song, reading the microphone every 100 ms. */
function run(midi: number[], sing: (frame: number, note: number) => number | null, opts?: Options) {
  const s = createScorer({ hop: 0.05, midi }, opts);
  for (let i = 0; i < midi.length; i += 2) s.tick(i * 0.05 + 0.01, sing(i, midi[i]));
  return s;
}
const steady = [...hold(60, FRAMES), ...hold(67, FRAMES), ...hold(-1, 10), ...hold(64, FRAMES)]; // 3 notes and a pause

test('createScorer: all right = 100, silence = 0, only the frames with a voice in the original count', () => {
  assert.equal(run(steady, (_i, m) => (m < 0 ? null : m)).score(), 100);
  assert.equal(run(steady, () => null).score(), 0);
  assert.equal(run(steady, (_i, m) => (m < 0 ? null : m)).evaluated, 60); // 120 frames with a voice, read two at a time
  assert.equal(run(steady, (_i, m) => (m < 0 ? null : m + 12)).score(), 100); // an octave above counts too
});

test('createScorer: checks ONE note per 2 s block and ignores the changes inside it', () => {
  // the original varies inside the block (60 for 60% of the time, 62 for the rest); whoever sings the main note gets it right
  const wobbling = [...hold(60, 24), ...hold(62, 16)];
  const s = run(wobbling, (_i, m) => m);
  assert.equal(s.score(), 100);
  assert.equal(s.reference, 60); // the "original" shown is a single one during the block
});

test("createScorer: a wrong note does not score, an almost right one earns most of it, the detector's misses do not punish", () => {
  const sing = (offset: number, every = 1) => run(hold(60, FRAMES * 2), (i) => (i % (2 * every) === 0 ? 60 + offset : null)).score();
  assert.equal(sing(5), 0); // a wrong fifth
  assert.equal(sing(3), 50); // a small error: half the score
  assert.equal(sing(2), 80); // almost: most of the point
  assert.equal(sing(1), 100);
  assert.equal(sing(0, 2), 100); // the detector catches only half the readings
  assert.ok((sing(0, 20) ?? 0) < 40); // almost mute: 1 reading in 20 (with the note held, ~10% of the frames)
});

test('createScorer: the chosen key shifts the melody, and a frame does not count twice', () => {
  const s = createScorer({ hop: 0.05, midi: hold(60, FRAMES) }, { transpose: 2 });
  s.tick(0.01, 62);
  s.tick(0.02, 40); // the same frame: ignored
  assert.equal(s.score(), 100);
  assert.equal(s.evaluated, 1);
  assert.equal(s.reference, 62);
  assert.equal(createScorer({ hop: 0.05, midi: hold(60, FRAMES) }).score(), null);
});

test('createScorer: singing one fixed note over a melody that varies does not earn a high score', () => {
  const notes = [60, 67, 64, 69, 62, 66, 65, 70];
  const midi = Array.from({ length: 320 }, (_, i) => notes[Math.floor(i / FRAMES) % notes.length]); // one note per block
  assert.ok((run(midi, () => 60).score() ?? 0) < 40);
  assert.equal(run(midi, (_i, m) => m).score(), 100);
});

test('createScorer: holds the last note for 150 ms (consonants and breaths do not count as silence)', () => {
  const s = createScorer({ hop: 0.05, midi: hold(60, FRAMES * 2) });
  s.tick(0.0, 60);
  s.tick(0.05, null);
  s.tick(0.1, null);
  assert.equal(s.score(), 100);
  assert.equal(s.sung, 60); // C4
  s.tick(2.5, null); // another block, 2.5 s later: real silence
  assert.equal(s.score(), 75);
});

test("noteName: the note's name with its octave", () => {
  assert.equal(noteName(69), 'A4');
  assert.equal(noteName(60), 'C4');
  assert.equal(noteName(61.4), 'C#4');
  assert.equal(noteName(null), '—');
  assert.equal(noteName(-1), '—');
});

test("smoothMelody: vibrato, the detector's spikes and short stretches become steady notes", () => {
  const wobble = [...Array(10).fill(60), 61, 60, 59, 60, 61, 60, 60, 60, 59, 60]; // a 1-semitone vibrato
  assert.deepEqual(smoothMelody(wobble), Array(20).fill(60));
  const spike = [...hold(60, 10), 72, ...hold(60, 9)]; // one frame with an octave error
  assert.deepEqual(smoothMelody(spike), Array(20).fill(60));
  const short = [...hold(60, 10), ...hold(67, 3), ...hold(60, 10)]; // 150 ms on another note: absorbed
  assert.deepEqual(smoothMelody(short), Array(23).fill(60));
  const steps = [...hold(60, 8), ...hold(64, 8), -1, -1, ...hold(67, 8)];
  assert.deepEqual(smoothMelody(steps), [...hold(60, 8), ...hold(64, 8), -1, -1, ...hold(67, 8)]); // real changes stay
  assert.deepEqual(smoothMelody(hold(60, 3)), hold(-1, 3)); // a lone note too short: it goes away
});

test('createScorer: onBlock and report describe the comparison (the stretch, the original note, the sung note)', () => {
  const logged: unknown[] = [];
  const midi = [...hold(60, FRAMES), ...hold(67, FRAMES)];
  const s = createScorer({ hop: 0.05, midi }, { onBlock: (row) => logged.push(row) });
  for (let i = 0; i < midi.length; i += 2) s.tick(i * 0.05 + 0.01, i < FRAMES ? 60 : 62); // gets the 1st block right, the 2nd wrong
  assert.equal(logged.length, 1); // the 2nd block has not ended yet
  assert.deepEqual(logged[0], { span: '00:00–00:02', original: 'C4', main: 'C', sung: 'C4', distance: 0, accuracy: 1, readings: '20/20', participation: 1 });
  const [first, second] = s.report();
  assert.equal(first.span, '00:00–00:02');
  assert.deepEqual([second.span, second.original, second.sung, second.distance, second.accuracy], ['00:02–00:04', 'G4', 'D4', 5, 0]);
});

test('createScorer: when the original goes through several notes in a block, the most frequent counts (not zero)', () => {
  const wandering = [...hold(60, 14), ...hold(63, 13), ...hold(66, 13)]; // none reaches 40% of the block
  assert.equal(run(wandering, () => 60).score(), 100);
  assert.equal(run(wandering, () => 60).report()[0].main, 'C');
});

test("createScorer: the sung note shown has the singer's octave", () => {
  const s = createScorer({ hop: 0.05, midi: hold(57, FRAMES) }); // the original: A3
  for (let i = 0; i < FRAMES; i += 2) s.tick(i * 0.05 + 0.01, i < 10 ? 57 : 69); // the person sings A4 most of the time
  assert.equal(noteName(s.reference), 'A3');
  assert.equal(noteName(s.sung), 'A4');
  assert.equal(s.score(), 100); // the octave does not change the score
});

test("createScorer with include (a Duet): only this singer's instants count; the silence outside them does not punish", () => {
  const midi = [...hold(60, FRAMES), ...hold(67, FRAMES)]; // 0–2 s: note 60 (voice 1); 2–4 s: note 67 (voice 2)
  const voiceOne = (t: number) => t < 2;
  const voiceTwo = (t: number) => t >= 2;
  // voice 1 gets its part right and stays quiet in voice 2's; voice 2 does the opposite
  const one = run(midi, (i) => (i < FRAMES ? 60 : null), { include: voiceOne });
  const two = run(midi, (i) => (i >= FRAMES ? 67 : null), { include: voiceTwo });
  assert.equal(one.score(), 100);
  assert.equal(two.score(), 100);
  // without include, staying quiet in the other's part would cost half the score
  assert.equal(run(midi, (i) => (i < FRAMES ? 60 : null)).score(), 50);
  // whoever gets their own part wrong is still held to it
  assert.equal((run(midi, (i) => (i < FRAMES ? 62 : null), { include: voiceOne }).score() ?? 0) < 100, true);
  // and the other singer's frames do not even enter the count (fewer frames evaluated)
  assert.ok(one.evaluated < run(midi, () => null).evaluated);
});
