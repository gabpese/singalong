// Requests that arrive at the same time. Each test fires them together and checks that the outcome is one a sequence of the
// same requests could have produced. They guard the move to an asynchronous database (ADR 0017), where an `await` in the
// middle of a rule would let a second request act on half-updated state.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { MikroORM } from '@mikro-orm/core';
import { buildApp } from '../dist/app.js';
import { ormOptions } from '../dist/database/orm.js';
import { openDb } from '../dist/db.js';
import { createMemoryJobStore } from '../dist/jobs.js';
import { RoomService } from '../dist/rooms/room.service.js';
import { MAX_PER_CLIENT } from '../dist/rooms/rooms.js';
import { LocalStorage } from '../dist/storage.js';

const BIG = { max: 1e6, windowMs: 60_000 };
const NO_LIMITS = { search: BIG, addToQueue: BIG, createRoom: BIG, pair: BIG };
const ADMIN = { 'x-admin-token': 'admin-secret' };
const READY = ['readySongA1', 'readySongB1', 'readySongC1', 'readySongD1'];
const ANA = 'client-ana-0001';

let root;
let app;

async function seed(id) {
  const dir = join(root, 'cache', id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'instrumental.mp3'), '0123456789');
  await writeFile(join(dir, 'lyrics.json'), '[]');
  await writeFile(join(dir, 'meta.json'), JSON.stringify({ video_id: id, title: `Title ${id}`, artist: 'Artist', duration: 200 }));
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'singalong-concurrency-'));
  for (const id of READY) await seed(id);
  app = await buildApp({ config: { publicDir: root, adminToken: 'admin-secret', rateLimits: NO_LIMITS }, storage: new LocalStorage(root), jobs: createMemoryJobStore() });
  await app.ready();
});

after(() => app.close());

const inject = (method, url, { headers = {}, payload } = {}) => app.inject({ method, url, headers, payload });
const api = (method, url, { client = ANA, host, payload } = {}) =>
  inject(method, `/api${url}`, { headers: { 'x-client-id': client, ...(host ? { 'x-host-token': host } : {}) }, payload });

async function newRoom() {
  const res = await api('POST', '/rooms');
  assert.equal(res.statusCode, 201);
  return { code: res.json().code, host: res.json().host_token };
}

const add = (code, videoId, client = ANA) => api('POST', `/rooms/${code}/queue`, { client, payload: { video_id: videoId, name: 'Ana', artist: 'Artist', title: 'Title' } });
const state = async (code) => (await api('GET', `/rooms/${code}`)).json();

async function pair() {
  const start = await inject('POST', '/agent/v1/pair/start', { headers: ADMIN, payload: {} });
  const done = await inject('POST', '/agent/v1/pair/complete', { payload: { code: start.json().code, name: 'PC' } });
  return { id: done.json().device_id, headers: { authorization: `Bearer ${done.json().token}` } };
}

const startSession = (agent) => inject('POST', '/agent/v1/sessions', { headers: agent.headers, payload: { display_name: 'Ana' } });

test('songs added at once by one person never pass the per-person limit', async () => {
  const { code } = await newRoom();
  const extra = 5;
  // songs still being prepared stay queued (none starts playing), so every one of them counts against the limit
  const ids = Array.from({ length: MAX_PER_CLIENT + extra }, (_, i) => `slowSong${String(i).padStart(3, '0')}`);
  const answers = await Promise.all(ids.map((id) => add(code, id)));
  assert.equal(answers.filter((res) => res.statusCode === 201).length, MAX_PER_CLIENT);
  assert.deepEqual(answers.filter((res) => res.statusCode !== 201).map((res) => res.json().error), Array(extra).fill('too_many'));
  assert.equal((await state(code)).queue.length, MAX_PER_CLIENT);
});

test('the TV ending a song while the Host skips it advances the queue only once', async () => {
  const { code, host } = await newRoom();
  for (const id of READY.slice(0, 3)) assert.equal((await add(code, id)).statusCode, 201);
  const before = await state(code);
  const [playing, second, third] = before.queue;
  assert.equal(before.current_item_id, playing.id);
  // the Host's phone names the song on its screen; by the time the skip arrives, the TV has already ended that song
  await Promise.all([app.rooms.tvEnded(code, playing.id), api('POST', `/rooms/${code}/player/skip`, { host, payload: { item_id: playing.id } })]);
  const after = await state(code);
  assert.equal(after.current_item_id, second.id);
  assert.deepEqual(after.queue.map((item) => [item.id, item.status]), [[second.id, 'playing'], [third.id, 'queued']]);
});

test('a score sent as the song ends is kept for that song', async () => {
  const { code, host } = await newRoom();
  assert.equal((await api('PATCH', `/rooms/${code}`, { host, payload: { scoring: true } })).statusCode, 200);
  for (const id of READY.slice(0, 2)) await add(code, id);
  const { current_item_id: playing } = await state(code);
  // the TV sends the score and then "ended", one right after the other
  await Promise.all([app.rooms.tvScore(code, playing, 87), app.rooms.tvEnded(code, playing)]);
  assert.deepEqual((await state(code)).scoreboard.map((row) => [row.id, row.score]), [[playing, 87]]);
});

test('moves at once keep every song in the queue exactly once', async () => {
  const { code, host } = await newRoom();
  for (const id of READY) await add(code, id);
  const waiting = (await state(code)).queue.filter((item) => item.status === 'queued').map((item) => item.id);
  const move = (id, direction) => api('POST', `/rooms/${code}/queue/${id}/move`, { host, payload: { direction } });
  await Promise.all([move(waiting[2], 'up'), move(waiting[1], 'down'), move(waiting[0], 'down')]);
  const order = (await state(code)).queue.filter((item) => item.status === 'queued').map((item) => item.id);
  assert.deepEqual([...order].sort(), [...waiting].sort());
});

test('a pairing code used twice at once pairs only one computer', async () => {
  const start = await inject('POST', '/agent/v1/pair/start', { headers: ADMIN, payload: {} });
  const { code } = start.json();
  const answers = await Promise.all([1, 2].map((n) => inject('POST', '/agent/v1/pair/complete', { payload: { code, name: `PC ${n}` } })));
  assert.deepEqual(answers.map((res) => res.statusCode).sort(), [201, 400]);
});

test('starting a session twice at once leaves the computer with one active session', async () => {
  const agent = await pair();
  const earlier = (await startSession(agent)).json();
  // straight to the service: ending the earlier session waits on the job store, which is where two starts used to interleave
  const device = app.db.getDevice(agent.id);
  const started = await Promise.all([app.agents.startSession(device, 'Ana'), app.agents.startSession(device, 'Ana')]);
  const sessions = [earlier, ...started].map((session) => app.db.getSession(session.id));
  assert.equal(sessions.filter((session) => !session.ended_at).length, 1);
});

test('rooms created at once never share a code', async () => {
  const db = openDb(':memory:');
  const orm = await MikroORM.init(ormOptions(db.connection));
  await orm.migrator.up();
  const codes = ['SAME', 'SAME', 'SAME', 'NEXT'];
  const rooms = new RoomService({ orm, songs: {}, newCode: () => codes.shift() });
  const created = await Promise.all([rooms.createRoom(), rooms.createRoom()]);
  assert.deepEqual(created.map((room) => room.code).sort(), ['NEXT', 'SAME']);
  await orm.close();
  db.close();
});
