import assert from 'node:assert/strict';
import test from 'node:test';
import { downloadTarget, exportFileName, requestExport } from '../src/lib/export-mp4.ts';

type Api = Parameters<typeof requestExport>[0];

test('exportFileName: "Artist - Title (key).mp4" without invalid characters', () => {
  assert.equal(exportFileName({ artist: 'Stone Sour', title: 'Wicked Game', video_id: 'x' }), 'Stone Sour - Wicked Game.mp4');
  assert.equal(exportFileName({ artist: 'AC/DC', title: 'Who Made Who?', video_id: 'x' }, 2), 'AC DC - Who Made Who (+2).mp4');
  assert.equal(exportFileName({ title: 'Só o título', video_id: 'x' }, -3), 'Só o título (-3).mp4');
  assert.equal(exportFileName({ title: null, artist: null, video_id: 'abcdefghijk' }), 'abcdefghijk.mp4');
  assert.ok(exportFileName({ title: 'a'.repeat(500), video_id: 'x' }).length <= 125);
});

test('requestExport: asks, waits for the worker and answers the URL; errors become a message', async () => {
  const calls: unknown[][] = [];
  const replies = [{ status: 'pending', url: null, error: null }, { status: 'processing', url: null, error: null }, { status: 'ready', url: '/media/x.mp4', error: null }];
  const api: Api = async (method, path, body) => {
    calls.push([method, path, body]);
    return replies.shift()!;
  };
  let waited = 0;
  const url = await requestExport(api, 'abcdefghijk', 2, { sleep: async () => {}, onWaiting: () => { waited++; } });
  assert.equal(url, '/media/x.mp4');
  assert.equal(waited, 2);
  assert.deepEqual(calls, [
    ['POST', '/api/songs/abcdefghijk/export', { pitch: 2 }],
    ['GET', '/api/songs/abcdefghijk/export?pitch=2', undefined],
    ['GET', '/api/songs/abcdefghijk/export?pitch=2', undefined],
  ]);

  const failing: Api = async () => ({ status: 'failed', url: null, error: 'ffmpeg failed' });
  await assert.rejects(requestExport(failing, 'abcdefghijk', 0, { sleep: async () => {} }), /ffmpeg failed/);
  const stuck: Api = async () => ({ status: 'pending', url: null, error: null });
  await assert.rejects(requestExport(stuck, 'abcdefghijk', 0, { sleep: async () => {}, timeoutMs: -1 }), /demorando/);
});

test('downloadTarget: from the same origin it uses the download attribute; from another (the local media server) it asks for the name with ?download=', () => {
  assert.deepEqual(downloadTarget('/media/cache/x/karaoke.mp4', 'A - B.mp4', 'https://singalong.example'), { href: '/media/cache/x/karaoke.mp4', useDownloadAttribute: true });
  const local = downloadTarget('http://127.0.0.1:8765/tok/cache/abcdefghijk/karaoke_p+2.mp4', 'Legião - Tempo Perdido (+2).mp4', 'https://singalong.example');
  assert.equal(local.useDownloadAttribute, false);
  const url = new URL(local.href);
  assert.equal(url.origin, 'http://127.0.0.1:8765');
  assert.equal(url.pathname, '/tok/cache/abcdefghijk/karaoke_p+2.mp4');
  assert.equal(url.searchParams.get('download'), 'Legião - Tempo Perdido (+2).mp4');
});
