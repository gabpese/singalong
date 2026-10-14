import assert from 'node:assert/strict';
import test from 'node:test';
import { easeRange, foldToNearestOctave, isGood, makeScale, melodyNotes, noteAt, notesInWindow, pitchRange, pushTrail, SECONDS_AFTER, SECONDS_BEFORE } from '../src/lib/melody-guide.js';

/** Uma melodia sintética: `hop` de 0,05 s; cada trecho = [nota | -1, quadros]. */
function melody(parts, hop = 0.05) {
  const midi = [];
  for (const [note, frames] of parts) for (let i = 0; i < frames; i++) midi.push(note);
  return { hop, midi };
}

test('melodyNotes: trechos contínuos da mesma nota, com os tempos certos, e o silêncio fica de fora', () => {
  const notes = melodyNotes(melody([[-1, 10], [60, 20], [-1, 10], [64, 20]]));
  assert.equal(notes.length, 2);
  assert.deepEqual(notes.map((n) => n.note), [60, 64]);
  assert.ok(Math.abs(notes[0].start - 0.5) < 1e-9 && Math.abs(notes[0].end - 1.5) < 1e-9);
  assert.ok(Math.abs(notes[1].start - 2) < 1e-9 && Math.abs(notes[1].end - 3) < 1e-9);
  assert.deepEqual(melodyNotes(null), []);
  assert.deepEqual(melodyNotes({ hop: 0.05, midi: [] }), []);
});

test('notesInWindow e noteAt: só as notas da janela; a nota do instante já no tom escolhido', () => {
  const notes = melodyNotes(melody([[60, 20], [-1, 20], [67, 20]])); // 0–1 s, 2–3 s
  assert.deepEqual(notesInWindow(notes, 0.5, 2.5).map((n) => n.note), [60, 67]);
  assert.deepEqual(notesInWindow(notes, 1.2, 1.8), []);
  assert.equal(noteAt(notes, 0.5), 60);
  assert.equal(noteAt(notes, 0.5, 2), 62); // tom +2
  assert.equal(noteAt(notes, 1.5), null); // pausa
  assert.equal(noteAt(notes, 2.5), 67);
});

test('pitchRange: cobre as notas com folga e nunca fica menor que uma oitava; sem notas não há faixa', () => {
  const wide = pitchRange([{ note: 55 }, { note: 79 }]);
  assert.deepEqual(wide, { low: 53, high: 81 });
  const narrow = pitchRange([{ note: 60 }]);
  assert.ok(narrow.high - narrow.low >= 12);
  assert.ok(narrow.low < 60 && narrow.high > 60);
  assert.deepEqual(pitchRange([{ note: 60 }], 2), { low: pitchRange([{ note: 62 }]).low, high: pitchRange([{ note: 62 }]).high }); // o tom escolhido desloca a faixa
  assert.equal(pitchRange([]), null);
});

test('easeRange: anda aos poucos até a faixa nova e aceita o primeiro valor', () => {
  assert.deepEqual(easeRange(null, { low: 50, high: 70 }), { low: 50, high: 70 });
  const step = easeRange({ low: 50, high: 70 }, { low: 60, high: 80 }, 0.5);
  assert.deepEqual(step, { low: 55, high: 75 });
  assert.deepEqual(easeRange({ low: 1, high: 2 }, null), { low: 1, high: 2 });
});

test('foldToNearestOctave e isGood: quem canta uma oitava fora aparece junto da barra, e o acerto ignora a oitava', () => {
  assert.equal(foldToNearestOctave(48, 62), 60); // uma oitava abaixo: sobe para perto de 62
  assert.equal(foldToNearestOctave(76, 62), 64);
  assert.equal(foldToNearestOctave(null, 62), null);
  assert.equal(foldToNearestOctave(60, null), 60);
  assert.equal(isGood(48, 60), true); // a mesma nota, outra oitava
  assert.equal(isGood(61, 60), true); // um semitom ainda vale
  assert.equal(isGood(63, 60), false);
  assert.equal(isGood(null, 60), false);
});

test('makeScale: o "agora" fica a 1/4 da esquerda; o futuro à direita e as notas agudas no alto', () => {
  const range = { low: 50, high: 74 };
  const scale = makeScale({ position: 10, width: 800, height: 240, range });
  assert.equal(scale.x(10), scale.nowX);
  assert.equal(scale.nowX, (SECONDS_BEFORE / (SECONDS_BEFORE + SECONDS_AFTER)) * 800);
  assert.equal(scale.x(10 + SECONDS_AFTER), 800);
  assert.equal(scale.x(10 - SECONDS_BEFORE), 0);
  assert.ok(scale.y(72) < scale.y(52)); // mais agudo, mais acima (y menor)
  assert.equal(scale.y(50), 240);
  assert.equal(scale.y(74), 0);
  assert.ok(scale.barHeight >= 6);
  assert.equal(makeScale({ position: 0, width: 100, height: 100, range: null }).y(60), 50); // sem faixa: no meio
});

test('pushTrail: guarda só os últimos segundos', () => {
  let trail = [];
  for (let t = 0; t <= 10; t += 0.5) trail = pushTrail(trail, { t, midi: 60 });
  assert.ok(trail.length <= 7);
  assert.equal(trail[trail.length - 1].t, 10);
  assert.ok(trail[0].t >= 7);
});
