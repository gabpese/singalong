import assert from 'node:assert/strict';
import test from 'node:test';
import { accessMessage, HINT_AFTER_MS, localMediaBase, probeLocalMedia } from '../src/lib/local-media.ts';

type State = Parameters<typeof localMediaBase>[0];
type FetchImpl = NonNullable<NonNullable<Parameters<typeof probeLocalMedia>[1]>['fetchImpl']>;

const item = (media: { local: boolean; instrumental: string } | null) => ({ song: { media } });
const state = (queue: ReturnType<typeof item>[]) => ({ queue }) as unknown as State;

test("localMediaBase: the local server's address, taken from the Queue's first local song", () => {
  const local = { local: true, instrumental: 'http://127.0.0.1:8765/tok123/cache/abcdefghijk/instrumental.mp3' };
  assert.equal(localMediaBase(state([item(null), item({ local: false, instrumental: '/media/cache/x/instrumental.mp3' }), item(local)])), 'http://127.0.0.1:8765/tok123');
  assert.equal(localMediaBase(state([item({ local: false, instrumental: '/media/cache/x/instrumental.mp3' })])), null);
  assert.equal(localMediaBase(state([])), null);
  assert.equal(localMediaBase(null), null);
  assert.equal(localMediaBase(state([item({ local: true, instrumental: 'no-cache' })])), null);
});

test('accessMessage: explains the prompt only after a while pending, and guides when it was blocked', () => {
  assert.equal(accessMessage('idle'), '');
  assert.equal(accessMessage('ok', 99_999), '');
  assert.equal(accessMessage('checking', 0), ''); // it mostly answers at once: no flashing notice
  assert.equal(accessMessage('checking', HINT_AFTER_MS - 1), '');
  assert.match(accessMessage('checking', HINT_AFTER_MS), /escolha Permitir/);
  assert.match(accessMessage('blocked'), /bloqueou/);
  assert.match(accessMessage('blocked'), /rede local/);
});

test('probeLocalMedia: ok when it answers, false when it fails or takes too long', async () => {
  const calls: [string, RequestCache | undefined][] = [];
  const ok = (async (url: string, options: RequestInit) => {
    calls.push([url, options.cache]);
    return { ok: true };
  }) as unknown as FetchImpl;
  assert.equal(await probeLocalMedia('http://127.0.0.1:8765/tok', { fetchImpl: ok }), true);
  assert.deepEqual(calls, [['http://127.0.0.1:8765/tok/ping', 'no-store']]);
  assert.equal(await probeLocalMedia('http://x/t', { fetchImpl: (async () => ({ ok: false })) as unknown as FetchImpl }), false);
  assert.equal(await probeLocalMedia('http://x/t', { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } }), false);
  // no answer: the time limit aborts the request
  const hanging = ((_url: string, options: RequestInit) => new Promise((_, reject) => options.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as FetchImpl;
  assert.equal(await probeLocalMedia('http://x/t', { fetchImpl: hanging, timeoutMs: 20 }), false);
});
