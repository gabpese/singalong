import assert from 'node:assert/strict';
import test from 'node:test';
import { dismissStage, stageDismissed, stageItemFor } from '../src/lib/stage.js';

const state = (over = {}) => ({
  playback: 'playing',
  tv_connected: true,
  current_item_id: 7,
  queue: [{ id: 7, mine: true }, { id: 8, mine: false }],
  ...over,
});

test('a música tocando é minha, a TV está conectada e não saí do palco: vou para o palco', () => {
  assert.equal(stageItemFor(state()), 7);
  assert.equal(stageItemFor(state({ playback: 'paused' })), 7); // pausada também: o cantor já está no palco
});

test('não vou ao palco se a música é de outra pessoa, nada toca ou a TV está desligada', () => {
  assert.equal(stageItemFor(state({ current_item_id: 8 })), null);
  assert.equal(stageItemFor(state({ playback: 'idle' })), null);
  assert.equal(stageItemFor(state({ tv_connected: false })), null);
  assert.equal(stageItemFor(state({ current_item_id: null })), null);
  assert.equal(stageItemFor(null), null);
});

test('quem saiu do palco nesta música não é levado de volta, mas na próxima música é', () => {
  const storage = new Map();
  const fake = { setItem: (k, v) => storage.set(k, v), getItem: (k) => storage.get(k) ?? null };
  const dismissed = (id) => stageDismissed('ABCD', id, fake);
  assert.equal(stageItemFor(state(), dismissed), 7);
  dismissStage('ABCD', 7, fake);
  assert.equal(stageItemFor(state(), dismissed), null);
  assert.equal(stageItemFor(state({ current_item_id: 8, queue: [{ id: 8, mine: true }] }), dismissed), 8); // outra música
  assert.equal(stageDismissed('ZZZZ', 7, fake), false); // e é por sala
});

test('sem armazenamento (navegador bloqueado) nada quebra', () => {
  const broken = { setItem() { throw new Error('bloqueado'); }, getItem() { throw new Error('bloqueado'); } };
  assert.doesNotThrow(() => dismissStage('ABCD', 7, broken));
  assert.equal(stageDismissed('ABCD', 7, broken), false);
});

test('no dueto o convidado que aceitou também vai ao palco, mas quem só foi convidado (ainda não aceitou) não', () => {
  assert.equal(stageItemFor(state({ queue: [{ id: 7, mine: false, guest_me: true }] })), 7);
  assert.equal(stageItemFor(state({ queue: [{ id: 7, mine: false, guest_me: false, invite_for_me: true }] })), null);
});
