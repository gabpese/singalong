import assert from 'node:assert/strict';
import test from 'node:test';
import { blockRms, createGate, GATE, rmsToDb } from '../src/lib/voice-gate.ts';

const rmsOf = (db: number) => 10 ** (db / 20);

test("rmsToDb and blockRms: the volume in dBFS and a block's RMS", () => {
  assert.equal(rmsToDb(1), 0);
  assert.ok(Math.abs(rmsToDb(0.5) + 6.02) < 0.01);
  assert.equal(rmsToDb(0), -Infinity);
  assert.equal(blockRms([]), 0);
  assert.ok(Math.abs(blockRms([0.5, -0.5, 0.5, -0.5]) - 0.5) < 1e-12);
});

test('the gate starts closed, opens with a voice, and the pause between words does not close it', () => {
  const gate = createGate();
  assert.equal(gate.target(rmsOf(-70), 0), GATE.floor); // only the room's noise
  assert.equal(gate.target(rmsOf(-30), 50), 1); // the voice came in: it opens at once
  assert.equal(gate.target(rmsOf(-70), 150), 1); // a short silence (a pause): still open
  assert.equal(gate.target(rmsOf(-70), 300), 1);
  assert.equal(gate.target(rmsOf(-70), 50 + GATE.holdMs + 10), GATE.floor); // the hold time passed: it closes
});

test('a faint voice (between the two thresholds) keeps the gate open, without opening and closing every frame', () => {
  const gate = createGate();
  gate.target(rmsOf(-30), 0); // opens
  let t = 0;
  for (let i = 0; i < 20; i++) {
    t += 50;
    assert.equal(gate.target(rmsOf(-49), t), 1); // between -52 and -46: still open, and the hold renews
  }
  assert.equal(gate.target(rmsOf(-49), t + 5000), 1); // even much later, the faint voice holds it
  // but noise at that same level does NOT open a closed gate
  const closed = createGate();
  assert.equal(closed.target(rmsOf(-49), 0), GATE.floor);
});

test('once closed, it opens again only above the opening threshold', () => {
  const gate = createGate();
  gate.target(rmsOf(-30), 0);
  gate.target(rmsOf(-80), 1000); // closes
  assert.equal(gate.open, false);
  assert.equal(gate.target(rmsOf(-48), 1100), GATE.floor); // below the opening threshold
  assert.equal(gate.target(rmsOf(-40), 1200), 1); // the voice came back
});
