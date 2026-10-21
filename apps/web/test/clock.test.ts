import assert from 'node:assert/strict';
import test from 'node:test';
import { createSyncClock } from '../src/lib/clock.ts';

/** A local clock the test moves by hand (ms). */
function fake() {
  let t = 1_000_000;
  const clock = createSyncClock({ now: () => t });
  return { clock, advance: (ms: number) => { t += ms; }, set: (ms: number) => { t = ms; } };
}

test("before any message from the TV the clock is at zero and stopped", () => {
  const { clock, advance } = fake();
  advance(5000);
  assert.equal(clock.time(), 0);
});

test("it runs by itself between the TV's messages, at real time's pace", () => {
  const { clock, advance } = fake();
  clock.setPlaying(true);
  clock.position(10_000);
  advance(400);
  assert.ok(Math.abs(clock.time() - 10.4) < 0.001);
  advance(600);
  clock.position(11_000); // the next message arrives right on time: nothing changes
  assert.ok(Math.abs(clock.time() - 11) < 0.001);
});

test("the network's delay does not count: the least delayed message wins", () => {
  const { clock, advance } = fake();
  clock.setPlaying(true);
  // each message reports the true position (the TV was at 10 s, 11 s, 12 s...), but arrives with different delays
  const delays = [180, 40, 250, 90, 40, 300];
  let tvTime = 10_000;
  for (const delay of delays) {
    advance(1000);
    tvTime += 1000;
    // the message was sent `delay` ms before it arrived: when it arrives, the song is already at tvTime + delay
    clock.position(tvTime - delay);
  }
  // the TV's clock is now at 16 s (10 + 6); the estimate stays within 40 ms of it (the smallest delay seen)
  assert.ok(Math.abs(clock.time() - 16) <= 0.05, String(clock.time()));
});

test('pausing freezes, resuming goes on from there, and a new message corrects it', () => {
  const { clock, advance } = fake();
  clock.setPlaying(true);
  clock.position(20_000);
  advance(500);
  clock.setPlaying(false);
  const frozen = clock.time();
  assert.ok(Math.abs(frozen - 20.5) < 0.001);
  advance(30_000); // paused for a long time
  assert.equal(clock.time(), frozen);
  clock.setPlaying(true);
  assert.ok(Math.abs(clock.time() - frozen) < 0.001); // resumed from the same point
  advance(1000);
  clock.position(21_600); // the TV says it resumed a little later: the jump (>1.5 s? no: 0.1 s) is smoothed by the sample
  assert.ok(Math.abs(clock.time() - 21.6) < 0.2);
});

test('a big jump (the Host moved the song ahead) drops the old samples', () => {
  const { clock, advance } = fake();
  clock.setPlaying(true);
  clock.position(5000);
  advance(1000);
  clock.position(6000);
  advance(1000);
  clock.position(90_000); // jumped to 1:30
  assert.ok(Math.abs(clock.time() - 90) < 0.001);
  advance(500);
  assert.ok(Math.abs(clock.time() - 90.5) < 0.001);
});

test('reset forgets everything', () => {
  const { clock, advance } = fake();
  clock.setPlaying(true);
  clock.position(30_000);
  clock.reset();
  advance(5000);
  assert.equal(clock.time(), 0);
  assert.equal(clock.playing, false);
});

test('invalid values become zero instead of breaking', () => {
  const { clock } = fake();
  clock.setPlaying(true);
  clock.position('junk' as unknown as number);
  clock.position(-5);
  assert.ok(clock.time() >= 0);
});
