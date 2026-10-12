import assert from 'node:assert/strict';
import test from 'node:test';
import { accessMessage, HINT_AFTER_MS, localMediaBase, probeLocalMedia } from '../src/lib/local-media.js';

const item = (media) => ({ song: { media } });

test('localMediaBase: o endereço do servidor local, tirado da primeira música local da fila', () => {
  const local = { local: true, instrumental: 'http://127.0.0.1:8765/tok123/cache/abcdefghijk/instrumental.mp3' };
  assert.equal(localMediaBase({ queue: [item(null), item({ local: false, instrumental: '/media/cache/x/instrumental.mp3' }), item(local)] }), 'http://127.0.0.1:8765/tok123');
  assert.equal(localMediaBase({ queue: [item({ local: false, instrumental: '/media/cache/x/instrumental.mp3' })] }), null);
  assert.equal(localMediaBase({ queue: [] }), null);
  assert.equal(localMediaBase(null), null);
  assert.equal(localMediaBase({ queue: [item({ local: true, instrumental: 'sem-cache' })] }), null);
});

test('accessMessage: explica o aviso só depois de um tempo pendente e orienta quando bloqueou', () => {
  assert.equal(accessMessage('idle'), '');
  assert.equal(accessMessage('ok', 99_999), '');
  assert.equal(accessMessage('checking', 0), ''); // a maioria das vezes responde na hora: sem piscar aviso
  assert.equal(accessMessage('checking', HINT_AFTER_MS - 1), '');
  assert.match(accessMessage('checking', HINT_AFTER_MS), /escolha Permitir/);
  assert.match(accessMessage('blocked'), /bloqueou/);
  assert.match(accessMessage('blocked'), /rede local/);
});

test('probeLocalMedia: ok quando responde, false quando falha ou demora demais', async () => {
  const calls = [];
  const ok = async (url, options) => { calls.push([url, options.cache]); return { ok: true }; };
  assert.equal(await probeLocalMedia('http://127.0.0.1:8765/tok', { fetchImpl: ok }), true);
  assert.deepEqual(calls, [['http://127.0.0.1:8765/tok/ping', 'no-store']]);
  assert.equal(await probeLocalMedia('http://x/t', { fetchImpl: async () => ({ ok: false }) }), false);
  assert.equal(await probeLocalMedia('http://x/t', { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }), false);
  // sem resposta: o tempo limite aborta o pedido
  const hanging = (url, options) => new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted'))));
  assert.equal(await probeLocalMedia('http://x/t', { fetchImpl: hanging, timeoutMs: 20 }), false);
});
