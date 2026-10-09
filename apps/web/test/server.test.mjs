import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { after, before } from 'node:test';

let server;
let base;

before(async () => {
  const root = await mkdtemp(join(tmpdir(), 'singalong-web-'));
  const dir = join(root, 'cache', 'abcdefghijk');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'instrumental.mp3'), Buffer.from('0123456789'));
  await writeFile(join(dir, 'lyrics.json'), '[]');
  await writeFile(join(dir, 'meta.json'), JSON.stringify({ video_id: 'abcdefghijk', title: 'T' }));
  await mkdir(join(root, 'cache', 'parcial'), { recursive: true });
  await writeFile(join(root, 'cache', 'parcial', 'instrumental.mp3'), 'x'); // sem meta/letra
  process.env.STORAGE_ROOT = root;
  const { createApp } = await import('../server.mjs');
  server = createApp();
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test('lista só músicas completas', async () => {
  const songs = await (await fetch(`${base}/api/songs`)).json();
  assert.deepEqual(songs.map((s) => s.video_id), ['abcdefghijk']);
});

test('Range: intervalo, sufixo e inválido', async () => {
  const url = `${base}/media/cache/abcdefghijk/instrumental.mp3`;
  let res = await fetch(url, { headers: { Range: 'bytes=2-4' } });
  assert.equal(res.status, 206);
  assert.equal(res.headers.get('content-range'), 'bytes 2-4/10');
  assert.equal(await res.text(), '234');
  res = await fetch(url, { headers: { Range: 'bytes=-3' } });
  assert.equal(await res.text(), '789');
  res = await fetch(url, { headers: { Range: 'bytes=50-60' } });
  assert.equal(res.status, 416);
  res = await fetch(url);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('accept-ranges'), 'bytes');
});

test('bloqueia path traversal e 404 em arquivo ausente', async () => {
  // fetch normaliza ".." na URL; usa socket cru para enviar o caminho como está
  const { connect } = await import('node:net');
  const { port } = server.address();
  for (const path of ['/media/../server.mjs', '/media/%2e%2e/server.mjs', '/%2e%2e/server.mjs']) {
    const status = await new Promise((resolveStatus, reject) => {
      const sock = connect(port, '127.0.0.1', () => sock.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
      let data = '';
      sock.on('data', (d) => (data += d));
      sock.on('end', () => resolveStatus(Number(data.split(' ')[1])));
      sock.on('error', reject);
    });
    assert.ok(status === 403 || status === 404, `${path} -> ${status}`);
  }
  assert.equal((await fetch(`${base}/media/cache/nada/x.mp3`)).status, 404);
});

test('serve a página inicial', async () => {
  const res = await fetch(`${base}/`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Singalong/);
});

test('safeJoin', async () => {
  const { safeJoin } = await import('../server.mjs');
  const root = resolve('/tmp/x');
  assert.equal(safeJoin(root, '../y'), null);
  assert.ok(safeJoin(root, 'a/b').startsWith(root));
});
