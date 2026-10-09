import assert from 'node:assert/strict';
import test from 'node:test';
import { exportFileName, requestExport } from '../src/lib/export-mp4.js';

test('exportFileName: "Artista - Título (tom).mp4" sem caracteres inválidos', () => {
  assert.equal(exportFileName({ artist: 'Stone Sour', title: 'Wicked Game', video_id: 'x' }), 'Stone Sour - Wicked Game.mp4');
  assert.equal(exportFileName({ artist: 'AC/DC', title: 'Who Made Who?', video_id: 'x' }, 2), 'AC DC - Who Made Who (+2).mp4');
  assert.equal(exportFileName({ title: 'Só o título', video_id: 'x' }, -3), 'Só o título (-3).mp4');
  assert.equal(exportFileName({ title: null, artist: null, video_id: 'abcdefghijk' }), 'abcdefghijk.mp4');
  assert.ok(exportFileName({ title: 'a'.repeat(500), video_id: 'x' }).length <= 125);
});

test('requestExport: pede, espera o worker e devolve a URL; erros viram mensagem', async () => {
  const calls = [];
  const replies = [{ status: 'pending' }, { status: 'processing' }, { status: 'ready', url: '/media/x.mp4' }];
  const api = async (method, path, body) => { calls.push([method, path, body]); return replies.shift(); };
  let waited = 0;
  const url = await requestExport(api, 'abcdefghijk', 2, { sleep: async () => {}, onWaiting: () => { waited++; } });
  assert.equal(url, '/media/x.mp4');
  assert.equal(waited, 2);
  assert.deepEqual(calls, [
    ['POST', '/api/songs/abcdefghijk/export', { pitch: 2 }],
    ['GET', '/api/songs/abcdefghijk/export?pitch=2', undefined],
    ['GET', '/api/songs/abcdefghijk/export?pitch=2', undefined],
  ]);

  const failing = async () => ({ status: 'failed', error: 'ffmpeg falhou' });
  await assert.rejects(requestExport(failing, 'abcdefghijk', 0, { sleep: async () => {} }), /ffmpeg falhou/);
  const stuck = async () => ({ status: 'pending' });
  await assert.rejects(requestExport(stuck, 'abcdefghijk', 0, { sleep: async () => {}, timeoutMs: -1 }), /demorando/);
});
