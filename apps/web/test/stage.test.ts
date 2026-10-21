import assert from 'node:assert/strict';
import test from 'node:test';
import { dismissStage, stageDismissed, stageItemFor } from '../src/lib/stage.ts';

type State = NonNullable<Parameters<typeof stageItemFor>[0]>;
type Storage = Parameters<typeof dismissStage>[2];

const state = (over: Record<string, unknown> = {}) => ({
  playback: 'playing',
  tv_connected: true,
  current_item_id: 7,
  queue: [{ id: 7, mine: true }, { id: 8, mine: false }],
  ...over,
}) as unknown as State;

test('the song playing is mine, the TV is connected and I did not leave the Stage: I go to the Stage', () => {
  assert.equal(stageItemFor(state()), 7);
  assert.equal(stageItemFor(state({ playback: 'paused' })), 7); // paused too: the singer is already on the Stage
});

test("I do not go to the Stage when the song is someone else's, nothing plays or the TV is off", () => {
  assert.equal(stageItemFor(state({ current_item_id: 8 })), null);
  assert.equal(stageItemFor(state({ playback: 'idle' })), null);
  assert.equal(stageItemFor(state({ tv_connected: false })), null);
  assert.equal(stageItemFor(state({ current_item_id: null })), null);
  assert.equal(stageItemFor(null), null);
});

test('whoever left the Stage during this song is not taken back, but is on the next song', () => {
  const storage = new Map<string, string>();
  const fake = { setItem: (k: string, v: string) => storage.set(k, v), getItem: (k: string) => storage.get(k) ?? null } as unknown as Storage;
  const dismissed = (id: number) => stageDismissed('ABCD', id, fake);
  assert.equal(stageItemFor(state(), dismissed), 7);
  dismissStage('ABCD', 7, fake);
  assert.equal(stageItemFor(state(), dismissed), null);
  assert.equal(stageItemFor(state({ current_item_id: 8, queue: [{ id: 8, mine: true }] }), dismissed), 8); // another song
  assert.equal(stageDismissed('ZZZZ', 7, fake), false); // and it is per Room
});

test('without storage (a blocked browser) nothing breaks', () => {
  const broken = { setItem() { throw new Error('blocked'); }, getItem() { throw new Error('blocked'); } } as unknown as Storage;
  assert.doesNotThrow(() => dismissStage('ABCD', 7, broken));
  assert.equal(stageDismissed('ABCD', 7, broken), false);
});

test('in a Duet the guest who accepted goes to the Stage too, but one only invited (who has not accepted yet) does not', () => {
  assert.equal(stageItemFor(state({ queue: [{ id: 7, mine: false, guest_me: true }] })), 7);
  assert.equal(stageItemFor(state({ queue: [{ id: 7, mine: false, guest_me: false, invite_for_me: true }] })), null);
});
