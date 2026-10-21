// Downloading: resuming, the required hash, the cache and failures. It uses a real local HTTP server (Range, drops halfway, 404).
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { ChecksumError, download, sha256File } from '../src/download.ts';

const BODY = Buffer.alloc(300_000, 'karaoke');
const HASH = createHash('sha256').update(BODY).digest('hex');
let server: Server;
let base: string;
let dir: string;
let flaky: (req: IncomingMessage, res: ServerResponse) => void = () => {};
const hits: { url: string | undefined; range: string | null }[] = [];

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'singalong-dl-'));
  server = createServer((req, res) => {
    hits.push({ url: req.url, range: req.headers.range ?? null });
    if (req.url === '/missing') return res.writeHead(404).end();
    if (req.url === '/flaky') return flaky(req, res);
    if (req.url === '/bad') return res.writeHead(200, { 'content-length': 10 }).end(Buffer.alloc(10, 'x'));
    if (req.url === '/no-range') return res.writeHead(200, { 'content-length': BODY.length }).end(BODY); // ignores Range
    const range = /bytes=(\d+)-/.exec(req.headers.range ?? '');
    if (range) {
      const start = Number(range[1]);
      if (start >= BODY.length) return res.writeHead(416).end();
      return res.writeHead(206, { 'content-length': BODY.length - start, 'content-range': `bytes ${start}-${BODY.length - 1}/${BODY.length}` }).end(BODY.subarray(start));
    }
    res.writeHead(200, { 'content-length': BODY.length }).end(BODY);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

test('downloads and checks the hash', async () => {
  const dest = join(dir, 'a.bin');
  const progress: { done: number; total: number }[] = [];
  const result = await download({ url: `${base}/file`, dest, sha256: HASH, onProgress: (p) => progress.push(p) });
  assert.equal(result.cached, false);
  assert.equal(await sha256File(dest), HASH);
  assert.equal(progress.at(-1)?.done, BODY.length);
  assert.equal(progress.at(-1)?.total, BODY.length);
});

test('a file already downloaded and checked is not downloaded again', async () => {
  const dest = join(dir, 'cache.bin');
  await download({ url: `${base}/file`, dest, sha256: HASH });
  const before = hits.length;
  const again = await download({ url: `${base}/file`, dest, sha256: HASH.toUpperCase() });
  assert.equal(again.cached, true);
  assert.equal(hits.length, before);
});

test('resumes where it stopped with Range when there is a .part', async () => {
  const dest = join(dir, 'resume.bin');
  await writeFile(`${dest}.part`, BODY.subarray(0, 100_000));
  await download({ url: `${base}/file`, dest, sha256: HASH });
  assert.equal(hits.at(-1)?.range, 'bytes=100000-');
  assert.equal(await sha256File(dest), HASH);
});

test('a server that ignores Range: starts over from zero without corrupting', async () => {
  const dest = join(dir, 'norange.bin');
  await writeFile(`${dest}.part`, BODY.subarray(0, 50_000));
  await download({ url: `${base}/no-range`, dest, sha256: HASH });
  assert.equal(await sha256File(dest), HASH);
});

test('the connection drops halfway and the download goes on by itself', async () => {
  let calls = 0;
  flaky = (req, res) => {
    calls++;
    const range = /bytes=(\d+)-/.exec(req.headers.range ?? '');
    const start = range ? Number(range[1]) : 0;
    if (calls === 1) { // sends a piece and drops
      res.writeHead(200, { 'content-length': BODY.length });
      res.write(BODY.subarray(0, 120_000));
      setTimeout(() => res.destroy(), 20);
      return;
    }
    res.writeHead(206, { 'content-length': BODY.length - start }).end(BODY.subarray(start));
  };
  const dest = join(dir, 'flaky.bin');
  await download({ url: `${base}/flaky`, dest, sha256: HASH, retryWait: 5 });
  assert.equal(await sha256File(dest), HASH);
  assert.ok(calls >= 2);
});

test('a wrong hash is refused and nothing is left at the destination', async () => {
  const dest = join(dir, 'bad.bin');
  await assert.rejects(download({ url: `${base}/bad`, dest, sha256: HASH, retryWait: 1, retries: 3 }), ChecksumError);
  assert.equal(await stat(dest).catch(() => null), null);
  assert.equal(await stat(`${dest}.part`).catch(() => null), null);
});

test('a 404 fails at once, without insisting', async () => {
  const before = hits.length;
  await assert.rejects(download({ url: `${base}/missing`, dest: join(dir, 'm.bin'), sha256: HASH, retryWait: 1 }), /404/);
  assert.equal(hits.length - before, 1);
});

test('a .part that is already the whole file (416) is accepted when it checks out', async () => {
  const dest = join(dir, 'full.bin');
  await writeFile(`${dest}.part`, BODY);
  await download({ url: `${base}/file`, dest, sha256: HASH });
  assert.equal((await readFile(dest)).length, BODY.length);
});
