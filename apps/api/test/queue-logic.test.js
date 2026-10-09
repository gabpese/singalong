import assert from 'node:assert/strict';
import { test } from 'node:test';
import { clampOffset, clampPitch, fairOrder, nextPlayable, swapTarget } from '../src/queue-logic.js';

const item = (id, video_id, client_id) => ({ id, video_id, client_id });

test('clampPitch e clampOffset', () => {
  assert.equal(clampPitch(3.6), 4);
  assert.equal(clampPitch(-99), -6);
  assert.equal(clampPitch('7'), 6);
  assert.equal(clampPitch('x'), 0);
  assert.equal(clampOffset(99), 10);
  assert.equal(clampOffset(-0.123456), -0.12);
  assert.equal(clampOffset(undefined), 0);
});

test('nextPlayable: ordem da fila e itens não prontos mantêm a posição', () => {
  const queue = [item(1, 'AAA', 'a'), item(2, 'BBB', 'b'), item(3, 'CCC', 'a')];
  assert.equal(nextPlayable(queue, new Set(['AAA', 'BBB', 'CCC'])).id, 1);
  assert.equal(nextPlayable(queue, new Set(['BBB', 'CCC'])).id, 2); // o 1 ainda processa: pula
  assert.equal(nextPlayable(queue, new Set()), null);
  assert.equal(nextPlayable([], new Set(['AAA'])), null);
});

test('nextPlayable: rodízio justo evita a mesma pessoa duas vezes seguidas', () => {
  const queue = [item(1, 'AAA', 'ana'), item(2, 'BBB', 'ana'), item(3, 'CCC', 'bia')];
  const ready = new Set(['AAA', 'BBB', 'CCC']);
  assert.equal(nextPlayable(queue, ready, { fair: false, lastClientId: 'ana' }).id, 1);
  assert.equal(nextPlayable(queue, ready, { fair: true, lastClientId: 'ana' }).id, 3); // Bia antes da 2ª da Ana
  assert.equal(nextPlayable(queue, ready, { fair: true, lastClientId: 'bia' }).id, 1);
  // só há músicas da mesma pessoa: toca mesmo assim
  assert.equal(nextPlayable([item(1, 'AAA', 'ana')], ready, { fair: true, lastClientId: 'ana' }).id, 1);
  // sem último cantor conhecido, é a ordem normal
  assert.equal(nextPlayable(queue, ready, { fair: true, lastClientId: null }).id, 1);
});

test('swapTarget', () => {
  assert.equal(swapTarget([1, 2, 3], 2, 'up'), 1);
  assert.equal(swapTarget([1, 2, 3], 2, 'down'), 3);
  assert.equal(swapTarget([1, 2, 3], 1, 'up'), null);
  assert.equal(swapTarget([1, 2, 3], 3, 'down'), null);
  assert.equal(swapTarget([1, 2, 3], 9, 'up'), null);
});

test('fairOrder: intercala as pessoas na fila inteira, uma música de cada por rodada', () => {
  const queue = [item(1, 'A', 'gabriel'), item(2, 'B', 'carlos'), item(3, 'C', 'carlos'), item(4, 'D', 'gabriel')];
  assert.deepEqual(fairOrder(queue).map((i) => i.id), [1, 2, 4, 3]);
  // quem cantou por último vai para o fim da primeira rodada
  assert.deepEqual(fairOrder(queue, 'gabriel').map((i) => i.id), [2, 1, 3, 4]);
  assert.deepEqual(fairOrder([item(1, 'A', 'ana'), item(2, 'B', 'ana')], 'ana').map((i) => i.id), [1, 2]);
});
