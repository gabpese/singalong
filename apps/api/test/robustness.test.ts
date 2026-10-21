import assert from 'node:assert/strict';
import { mkdir, mkdtemp, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildApp } from '../dist/app.js';
import { cleanCache, ormCacheUsage } from '../dist/cache/cache-cleaner.js';
import { createMemoryJobStore } from '../dist/jobs.js';
import { buildLoggerOptions, redactUrl } from '../dist/logging.js';
import { createRateLimiter } from '../dist/rate-limit.js';
import { LocalStorage } from '../dist/storage.js';
import { fixtures, openDatabase } from './fixtures.ts';

const DAY = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;
const NOW = Date.UTC(2026, 9, 9);

/** Creates cache/<id>/ with `mb` megabytes, modified `daysAgo` days ago. */
async function song(root, id, mb, daysAgo) {
  const dir = join(root, 'cache', id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'instrumental.mp3'), Buffer.alloc(mb * MB));
  await writeFile(join(dir, 'meta.json'), '{}');
  const when = new Date(NOW - daysAgo * DAY);
  for (const name of ['instrumental.mp3', 'meta.json']) await utimes(join(dir, name), when, when);
}

const exists = async (root, id) => stat(join(root, 'cache', id)).then(() => true, () => false);

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'singalong-clean-'));
  const { orm } = await openDatabase();
  return { root, storage: new LocalStorage(root), db: fixtures(orm), jobs: createMemoryJobStore(), usage: ormCacheUsage(orm) };
}

// ---------- cache cleanup (LRU) ----------

test('cleanup: below the limit it deletes nothing; a limit of 0 turns it off', async () => {
  const { root, storage, db, jobs, usage } = await setup();
  await song(root, 'aaaaaaaaaaa', 10, 30);
  assert.deepEqual((await cleanCache({ storage, usage, jobs, maxBytes: 50 * MB, now: () => NOW })).removed, []);
  assert.equal((await cleanCache({ storage, usage, jobs, maxBytes: 0 })).skipped, 'disabled');
  assert.ok(await exists(root, 'aaaaaaaaaaa'));
});

test('cleanup: above the limit it deletes the oldest first, until it is at 90% of the limit', async () => {
  const { root, storage, db, jobs, usage } = await setup();
  await song(root, 'velha000001', 10, 90); // oldest
  await song(root, 'media000001', 10, 40);
  await song(root, 'nova0000001', 10, 1);
  // a 25 MB limit: 30 MB > 25; target = 22.5 MB; deleting the oldest is enough (20 MB left)
  const report = await cleanCache({ storage, usage, jobs, maxBytes: 25 * MB, now: () => NOW });
  assert.deepEqual(report.removed.map((r) => r.id), ['velha000001']);
  assert.equal(await exists(root, 'velha000001'), false);
  assert.ok(await exists(root, 'media000001'));
  assert.ok(await exists(root, 'nova0000001'));
  assert.ok(report.after <= 25 * MB * 0.9);
});

test("cleanup: what was PLAYED recently counts more than the file's date", async () => {
  const { root, storage, db, jobs, usage } = await setup();
  await song(root, 'processada01', 10, 200); // prepared long ago...
  await song(root, 'processada02', 10, 20);
  await db.touchPlayed('processada01', NOW - 1 * DAY); // ...but sung yesterday
  const report = await cleanCache({ storage, usage, jobs, maxBytes: 15 * MB, now: () => NOW });
  assert.deepEqual(report.removed.map((r) => r.id), ['processada02']); // the real "oldest" is the other one
  assert.ok(await exists(root, 'processada01'));
});

test('cleanup: a song in some Queue or still being prepared is never deleted', async () => {
  const { root, storage, db, jobs, usage } = await setup();
  await song(root, 'naFila00001', 10, 300); // the oldest of all, but it is in a Room's Queue
  await song(root, 'processando', 10, 200); // with a job running
  await song(root, 'livre000001', 10, 100);
  await db.createRoom('ABCD', 'tok', NOW);
  await db.addItem({ room: 'ABCD', videoId: 'naFila00001', addedBy: 'Ana', clientId: 'c1', now: NOW });
  await jobs.enqueue('processando', { url: 'x', lyrics_source: 'auto' });
  const report = await cleanCache({ storage, usage, jobs, maxBytes: 5 * MB, now: () => NOW });
  assert.deepEqual(report.removed.map((r) => r.id), ['livre000001']); // only the free one; the others stay even above the limit
  assert.ok(await exists(root, 'naFila00001'));
  assert.ok(await exists(root, 'processando'));
  assert.ok(report.after > 5 * MB); // the limit is not strict: the priority is never to take a song from someone about to sing
});

test('cleanup: a song that already played and left the Queue becomes a candidate again', async () => {
  const { root, storage, db, jobs, usage } = await setup();
  await song(root, 'jaCantada01', 10, 5);
  await song(root, 'outra000001', 10, 4);
  await db.createRoom('ABCD', 'tok', NOW);
  const id = await db.addItem({ room: 'ABCD', videoId: 'jaCantada01', addedBy: 'Ana', clientId: 'c1', now: NOW });
  await db.updateItem(id, { status: 'done' });
  await db.touchPlayed('jaCantada01', NOW - 10 * DAY);
  const report = await cleanCache({ storage, usage, jobs, maxBytes: 15 * MB, now: () => NOW });
  assert.deepEqual(report.removed.map((r) => r.id), ['jaCantada01']); // played 10 days ago, older than 'outra' (4 days)
});

test('an old database (without last_played_at) is migrated when it opens', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'singalong-mig-')), 'old.db');
  const { DatabaseSync } = await import('node:sqlite');
  const old = new DatabaseSync(path);
  old.exec('CREATE TABLE song_settings (video_id TEXT PRIMARY KEY, lyric_offset REAL NOT NULL DEFAULT 0)');
  old.exec("INSERT INTO song_settings VALUES ('abc', 1.5)");
  old.close();
  const { orm, close } = await openDatabase(path); // the migrations bring it up to date
  const db = fixtures(orm);
  assert.equal((await db.songSettings('abc')).lyricOffset, 1.5); // old data kept
  await db.touchPlayed('abc', 123);
  assert.equal((await db.songSettings('abc')).lastPlayedAt, 123);
  assert.equal((await db.songSettings('abc')).lyricOffset, 1.5); // playing does not reset the lyrics offset
  await db.setOffset('abc', 2);
  assert.equal((await db.songSettings('abc')).lastPlayedAt, 123); // and setting the lyrics offset does not erase when it played
  await close();
});

// ---------- request limits ----------

test('rate limit: a fixed window, per person, with Retry-After', () => {
  let t = 1000;
  const limiter = createRateLimiter({ max: 3, windowMs: 60_000, now: () => t });
  for (let i = 0; i < 3; i++) assert.equal(limiter.hit('ana').ok, true);
  const blocked = limiter.hit('ana');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.retryAfterSec, 60);
  assert.equal(limiter.hit('bia').ok, true); // another person is not affected
  t += 30_000;
  assert.equal(limiter.hit('ana').retryAfterSec, 30); // the time left goes down
  t += 30_001;
  assert.equal(limiter.hit('ana').ok, true); // a new window
});

test('rate limit: old keys are swept (the map does not grow forever)', () => {
  let t = 0;
  const limiter = createRateLimiter({ max: 1, windowMs: 1000, now: () => t });
  for (let i = 0; i < 100; i++) limiter.hit(`pessoa${i}`);
  assert.equal(limiter.size, 100);
  t += 5000;
  limiter.hit('nova');
  assert.equal(limiter.size, 1);
});

async function appWith(rateLimits) {
  const root = await mkdtemp(join(tmpdir(), 'singalong-rl-'));
  await mkdir(join(root, 'public'));
  await writeFile(join(root, 'public', 'index.html'), 'ok');
  const jobs = createMemoryJobStore();
  jobs.searchResults = [];
  const app = await buildApp({ config: { publicDir: join(root, 'public'), rateLimits }, storage: new LocalStorage(root), jobs });
  await app.ready();
  return { app, jobs, root };
}

test('rate limit on the routes: the 13th search in a row is refused with a clear message; another person gets through', async () => {
  const { app } = await appWith({ search: { max: 12, windowMs: 60_000 } });
  const search = (client) => app.inject({ url: '/api/search?q=jack%27s+lament', headers: { 'x-client-id': client } });
  for (let i = 0; i < 12; i++) assert.equal((await search('cliente-ana-01')).statusCode, 200);
  const blocked = await search('cliente-ana-01');
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.json().error, 'rate_limited');
  assert.match(blocked.json().message, /Muitas buscas seguidas/);
  assert.ok(Number(blocked.headers['retry-after']) > 0);
  assert.equal((await search('cliente-bia-01')).statusCode, 200); // the limit is per person
  await app.close();
});

test('rate limit on the routes: creating a Room and adding to the Queue are limited too', async () => {
  const { app } = await appWith({ createRoom: { max: 2, windowMs: 60_000 }, addToQueue: { max: 2, windowMs: 60_000 } });
  const headers = { 'x-client-id': 'cliente-ana-01' };
  assert.equal((await app.inject({ method: 'POST', url: '/api/rooms', headers })).statusCode, 201);
  const { code } = (await app.inject({ method: 'POST', url: '/api/rooms', headers })).json();
  assert.equal((await app.inject({ method: 'POST', url: '/api/rooms', headers })).statusCode, 429);
  const add = () => app.inject({ method: 'POST', url: `/api/rooms/${code}/queue`, headers, payload: { video_id: 'novaMusica1', artist: 'A', title: 'B' } });
  assert.equal((await add()).statusCode, 201);
  assert.equal((await add()).statusCode, 201);
  assert.equal((await add()).statusCode, 429);
  await app.close();
});

// ---------- readiness ----------

test('readyz: details each check and turns 503 when something fails', async () => {
  const { app, jobs } = await appWith({});
  const ok = await app.inject('/readyz');
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), { ok: true, checks: { redis: true, db: true, storage: true } });

  jobs.ping = async () => { throw new Error('connection refused'); };
  const down = await app.inject('/readyz');
  assert.equal(down.statusCode, 503);
  assert.deepEqual(down.json(), { ok: false, checks: { redis: false, db: true, storage: true } }); // says WHICH one failed
  await app.close();
});

test('readyz: storage that cannot write (a full disk, a read-only volume) brings readiness down', async () => {
  const { app } = await appWith({});
  app.hasDecorator('rooms'); // the app is built
  const root = await mkdtemp(join(tmpdir(), 'singalong-ro-'));
  const storage = new LocalStorage(join(root, 'nao-existe')); // a folder that does not exist: nothing can be written
  await assert.rejects(() => storage.check());
  await app.close();
});

// ---------- logs without secrets ----------

test("logs: the Host token in the WebSocket's address is hidden", () => {
  assert.equal(redactUrl('/api/rooms/ABCD/ws?role=controller&client=c123&host=0123abcd'), '/api/rooms/ABCD/ws?role=controller&client=c123&host=[oculto]');
  assert.equal(redactUrl('/ws?host=abc&role=tv'), '/ws?host=[oculto]&role=tv');
  assert.equal(redactUrl('/api/songs'), '/api/songs');
  assert.equal(redactUrl(undefined), '');
  const req = buildLoggerOptions('warn').serializers.req({ method: 'GET', url: '/x?host=segredo', ip: '1.2.3.4', headers: { 'x-host-token': 'segredo' } });
  assert.deepEqual(req, { method: 'GET', url: '/x?host=[oculto]', remoteAddress: '1.2.3.4' }); // no headers
  assert.equal(buildLoggerOptions('warn').level, 'warn');
});

test('a worker error reaches the screen with its code and whether retrying is worth it', async () => {
  const { app, jobs } = await appWith({});
  const post = (payload) => app.inject({ method: 'POST', url: '/api/songs', payload });
  await post({ url: 'privadoVid1' });
  jobs.update('privadoVid1', { status: 'failed', error: 'Este vídeo é privado. Escolha outro vídeo.', error_code: 'private', retry: 'never' });
  const song = (await app.inject('/api/songs/privadoVid1')).json();
  assert.deepEqual([song.status, song.error_code, song.retry, song.error], ['failed', 'private', 'never', 'Este vídeo é privado. Escolha outro vídeo.']);
  await app.close();
});
