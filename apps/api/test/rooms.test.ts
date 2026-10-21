import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';
import { buildApp } from '../dist/app.js';
import { QueueItem } from '../dist/database/entities.js';
import { createMemoryJobStore } from '../dist/jobs.js';
import { LocalStorage } from '../dist/storage.js';
import { fixtures, openDatabase } from './fixtures.ts';

const NO_LIMITS = { search: { max: 1e6, windowMs: 60_000 }, addToQueue: { max: 1e6, windowMs: 60_000 }, createRoom: { max: 1e6, windowMs: 60_000 } };
const READY_A = 'readySongA1'; // 11 characters, like YouTube's IDs
const READY_B = 'readySongB1';
const READY_C = 'readySongC1';
const SLOW = 'slowSong001'; // still being prepared
const ANA = 'client-ana-0001';
const BIA = 'client-bia-0001';

let root;
let jobs;
let app;

async function seed(id) {
  const dir = join(root, 'cache', id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'instrumental.mp3'), '0123456789');
  await writeFile(join(dir, 'lyrics.json'), '[]');
  await writeFile(join(dir, 'meta.json'), JSON.stringify({ video_id: id, title: `Título ${id}`, artist: 'Artista', duration: 200, lyrics_source: 'lrclib' }));
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'singalong-rooms-'));
  const publicDir = join(root, 'public');
  await mkdir(publicDir);
  await writeFile(join(publicDir, 'index.html'), 'ok');
  for (const id of [READY_A, READY_B, READY_C]) await seed(id);
  jobs = createMemoryJobStore();
  app = await buildApp({ config: { publicDir, publicUrl: 'http://192.168.0.10:3000', rateLimits: NO_LIMITS }, storage: new LocalStorage(root), jobs });
  await app.ready();
});

after(() => app.close());

/** Calls the API as a client (and, optionally, as the Host). */
async function call(method, url, { client = ANA, host, body } = {}) {
  const headers = {};
  if (client) headers['x-client-id'] = client;
  if (host) headers['x-host-token'] = host;
  const res = await app.inject({ method, url: `/api${url}`, headers, payload: body });
  return { status: res.statusCode, body: res.body ? res.json() : null };
}

async function newRoom() {
  const { status, body } = await call('POST', '/rooms');
  assert.equal(status, 201);
  return { code: body.code, host: body.host_token };
}

/** A simulated WebSocket connection: it keeps what the server sent. */
async function fakeConn(code, { role = 'controller', client = ANA, host } = {}) {
  const sent = [];
  const socket = { readyState: 1, send: (data) => sent.push(JSON.parse(data)), ping() {}, terminate() {} };
  const session = await app.rooms.connect(code, { socket, role, clientId: client, hostToken: host });
  const lastState = () => sent.findLast((m) => m.type === 'state')?.state;
  return { session, sent, lastState };
}

const add = (code, videoId, opts = {}) => call('POST', `/rooms/${code}/queue`, { ...opts, body: { video_id: videoId, name: opts.name ?? 'Ana', artist: 'Artista', title: 'Título', ...(opts.extra ?? {}) } });
const queueIds = (state) => state.queue.map((i) => i.video_id);

test('creating a Room: a short code easy to type, a Host token, a Room that does not exist = 404', async () => {
  const { code, host } = await newRoom();
  assert.match(code, /^[A-HJKMNP-Z2-9]{4}$/);
  assert.equal(host.length, 32);
  const state = (await call('GET', `/rooms/${code.toLowerCase()}`)).body; // lower case works too
  assert.equal(state.code, code);
  assert.deepEqual([state.playback, state.queue.length, state.fair, state.tv_connected], ['idle', 0, false, false]);
  assert.equal((await call('GET', '/rooms/ZZZZ')).status, 404);
  assert.equal((await call('GET', '/rooms/ab')).status, 400);
});

test('config: the public address for the QR code', async () => {
  assert.equal((await call('GET', '/config')).body.public_url, 'http://192.168.0.10:3000');
});

test('adding: the first ready song starts playing; the others wait', async () => {
  const { code } = await newRoom();
  const first = await add(code, READY_A);
  assert.equal(first.status, 201);
  assert.equal(first.body.state.playback, 'playing');
  assert.equal(first.body.state.queue[0].status, 'playing');
  assert.equal(first.body.state.current_item_id, first.body.item_id);
  assert.equal(first.body.cached, true);

  const second = await add(code, READY_B);
  assert.deepEqual(queueIds(second.body.state), [READY_A, READY_B]);
  assert.equal(second.body.state.queue[1].status, 'queued');
  assert.equal(second.body.state.queue[0].title, `Título ${READY_A}`); // from meta.json
  assert.equal(second.body.state.queue[0].song.ready, true);
  assert.equal(second.body.state.queue[0].song.media.instrumental, `/media/cache/${READY_A}/instrumental.mp3`);
});

test('the TV says it ended: the Queue moves on, and an empty Queue goes back to "idle"', async () => {
  const { code } = await newRoom();
  const a = (await add(code, READY_A)).body;
  await add(code, READY_B);
  await app.rooms.tvEnded(code, 999); // an item that is not the current one: ignored (idempotent)
  assert.equal((await call('GET', `/rooms/${code}`)).body.current_item_id, a.item_id);

  await app.rooms.tvEnded(code, a.item_id);
  let state = (await call('GET', `/rooms/${code}`)).body;
  assert.deepEqual(queueIds(state), [READY_B]);
  assert.equal(state.queue[0].status, 'playing');

  await app.rooms.tvEnded(code, a.item_id); // repeated: nothing happens
  assert.equal((await call('GET', `/rooms/${code}`)).body.queue[0].status, 'playing');

  await app.rooms.tvEnded(code, state.current_item_id);
  state = (await call('GET', `/rooms/${code}`)).body;
  assert.deepEqual([state.playback, state.queue.length, state.current_item_id], ['idle', 0, null]);
});

test('a song still being prepared keeps its place, and the next ready one plays first', async () => {
  const { code } = await newRoom();
  const slow = await add(code, SLOW);
  assert.equal(slow.body.state.playback, 'idle'); // nothing ready yet
  assert.equal(slow.body.state.queue[0].song.ready, false);
  assert.equal(jobs.queue.some((j) => j.video_id === SLOW), true); // preparing has already started, behind the scenes

  const ready = await add(code, READY_A);
  assert.deepEqual(queueIds(ready.body.state), [READY_A, SLOW]); // the ready one plays (and comes first in the list)...
  assert.deepEqual(ready.body.state.queue.map((i) => i.status), ['playing', 'queued']); // ...and the slow one waits without losing its place

  await app.rooms.tvEnded(code, ready.body.item_id);
  assert.equal((await call('GET', `/rooms/${code}`)).body.playback, 'idle'); // the slow one is not ready yet

  // preparing ends: the Room's clock (tick) sets it playing
  await seed(SLOW);
  jobs.update(SLOW, { status: 'ready' });
  const conn = await fakeConn(code);
  await app.rooms.tick();
  const state = conn.lastState();
  assert.deepEqual([state.playback, state.queue[0].video_id, state.queue[0].status], ['playing', SLOW, 'playing']);
  conn.session.leave();
});

test('tick broadcasts the preparing progress, and the state reaches only those connected', async () => {
  const { code } = await newRoom();
  const id = 'progress001';
  await add(code, id);
  const conn = await fakeConn(code);
  jobs.update(id, { status: 'processing', stage: 'separating' });
  await app.rooms.tick();
  assert.equal(conn.lastState().queue[0].song.stage, 'separating');
  const before = conn.sent.length;
  await app.rooms.tick(); // nothing changed: the message is not repeated
  assert.equal(conn.sent.length, before);
  conn.session.leave();
});

test('permissions: the Host controls everything; the others only their own songs', async () => {
  const { code, host } = await newRoom();
  await add(code, READY_A, { client: ANA });
  const bia1 = (await add(code, READY_B, { client: BIA, name: 'Bia' })).body;

  // someone who is not the Host does not skip, pause or reorder
  assert.equal((await call('POST', `/rooms/${code}/player/skip`, { client: BIA })).status, 403);
  assert.equal((await call('POST', `/rooms/${code}/player/pause`, { client: BIA })).status, 403);
  assert.equal((await call('POST', `/rooms/${code}/queue/${bia1.item_id}/move`, { client: BIA, body: { direction: 'up' } })).status, 403); // jumping the Queue: only the Host
  assert.equal((await call('PATCH', `/rooms/${code}`, { client: BIA, body: { fair: true } })).status, 403);
  // a wrong token does not count either
  assert.equal((await call('POST', `/rooms/${code}/player/skip`, { client: BIA, host: 'x'.repeat(32) })).status, 403);

  // Ana does not remove Bia's song; Bia removes her own
  assert.equal((await call('DELETE', `/rooms/${code}/queue/${bia1.item_id}`, { client: ANA })).status, 403);
  const own = (await call('DELETE', `/rooms/${code}/queue/${bia1.item_id}`, { client: BIA })).body;
  assert.deepEqual(queueIds(own), [READY_A]);

  // the Host removes anyone's
  const bia2 = (await add(code, READY_C, { client: BIA, name: 'Bia' })).body;
  const byHost = (await call('DELETE', `/rooms/${code}/queue/${bia2.item_id}`, { client: ANA, host })).body;
  assert.deepEqual(queueIds(byHost), [READY_A]);
  assert.equal(byHost.me.is_host, true);
  assert.equal((await call('GET', `/rooms/${code}`, { client: BIA })).body.me.is_host, false);
});

test("each person's state has mine/can_edit and never exposes anyone's client_id", async () => {
  const { code, host } = await newRoom();
  await add(code, READY_A, { client: ANA });
  await add(code, READY_B, { client: BIA, name: 'Bia' });
  const asAna = (await call('GET', `/rooms/${code}`, { client: ANA })).body;
  assert.deepEqual(asAna.queue.map((i) => [i.mine, i.can_edit]), [[true, true], [false, false]]);
  const asHost = (await call('GET', `/rooms/${code}`, { client: BIA, host })).body;
  assert.deepEqual(asHost.queue.map((i) => i.can_edit), [true, true]);
  assert.equal(JSON.stringify(asAna).includes(ANA), false);
  assert.equal(JSON.stringify(asAna).includes(BIA), false);
});

test('reordering: swaps with the neighbor; the song playing does not move', async () => {
  const { code, host } = await newRoom();
  const a = (await add(code, READY_A)).body;
  const b = (await add(code, READY_B)).body;
  const c = (await add(code, READY_C)).body;
  const move = (id, direction) => call('POST', `/rooms/${code}/queue/${id}/move`, { host, body: { direction } });

  assert.deepEqual(queueIds((await move(c.item_id, 'up')).body), [READY_A, READY_C, READY_B]);
  assert.deepEqual(queueIds((await move(c.item_id, 'up')).body), [READY_A, READY_C, READY_B]); // 1st in the waiting Queue: no effect (A plays)
  assert.deepEqual(queueIds((await move(b.item_id, 'up')).body), [READY_A, READY_B, READY_C]);
  assert.deepEqual(queueIds((await move(c.item_id, 'down')).body), [READY_A, READY_B, READY_C]); // the last: no effect
  assert.equal((await move(a.item_id, 'down')).status, 409); // playing
  assert.equal((await move(99999, 'up')).status, 404);
});

test("giving up a turn: a song's Guest moves their own song back one place; moving up is still only the Host's", async () => {
  const { code, host } = await newRoom();
  await add(code, READY_A, { client: ANA, name: 'Ana' }); // plays
  const ana = (await add(code, READY_B, { client: ANA, name: 'Ana' })).body;
  const bia = (await add(code, READY_C, { client: BIA, name: 'Bia' })).body;
  const order = async () => queueIds((await call('GET', `/rooms/${code}`)).body);
  const move = (client, itemId, direction, h) => call('POST', `/rooms/${code}/queue/${itemId}/move`, { client, host: h, body: { direction } });

  assert.deepEqual(await order(), [READY_A, READY_B, READY_C]);
  // Bia does not touch Ana's song, nor Ana Bia's
  assert.equal((await move(BIA, ana.item_id, 'down')).status, 403);
  assert.equal((await move(ANA, bia.item_id, 'down')).status, 403);
  // Ana gives up her turn: her song goes down one place, Bia's goes up
  assert.deepEqual(queueIds((await move(ANA, ana.item_id, 'down')).body), [READY_A, READY_C, READY_B]);
  // each give-up moves back only one place; at the end there is nobody to give it to (no effect)
  assert.deepEqual(queueIds((await move(ANA, ana.item_id, 'down')).body), [READY_A, READY_C, READY_B]);
  // the song's Guest does not jump the Queue: moving up is the Host's
  assert.equal((await move(ANA, ana.item_id, 'up')).status, 403);
  assert.deepEqual(queueIds((await move(ANA, ana.item_id, 'up', host)).body), [READY_A, READY_B, READY_C]);
  // the song already playing does not give up its turn
  assert.equal((await move(ANA, (await call('GET', `/rooms/${code}`)).body.current_item_id, 'down')).status, 409);
  // who is next changed with it
  await move(ANA, ana.item_id, 'down');
  const state = (await call('GET', `/rooms/${code}`)).body;
  assert.equal(state.queue.find((i) => i.id === state.next_item_id).added_by, 'Bia');
});

test('skipping, pausing/resuming and removing the song playing', async () => {
  const { code, host } = await newRoom();
  await add(code, READY_A);
  await add(code, READY_B);
  await add(code, READY_C);

  const paused = (await call('POST', `/rooms/${code}/player/pause`, { host })).body;
  assert.equal(paused.playback, 'paused');
  assert.equal((await call('POST', `/rooms/${code}/player/resume`, { host })).body.playback, 'playing');

  const skipped = (await call('POST', `/rooms/${code}/player/skip`, { host })).body;
  assert.deepEqual(queueIds(skipped), [READY_B, READY_C]);
  assert.equal(skipped.queue[0].status, 'playing');

  const removed = (await call('DELETE', `/rooms/${code}/queue/${skipped.current_item_id}`, { host })).body; // removing the current one = skipping
  assert.deepEqual(queueIds(removed), [READY_C]);
  assert.equal(removed.queue[0].status, 'playing');

  const last = (await call('POST', `/rooms/${code}/player/skip`, { host })).body;
  assert.deepEqual([last.playback, last.queue.length], ['idle', 0]);
  assert.equal((await call('POST', `/rooms/${code}/player/pause`, { host })).body.playback, 'idle'); // no song: stays idle
});

test("the Key per song: limited to ±6, only the song's Guest or the Host change it", async () => {
  const { code, host } = await newRoom();
  const a = (await add(code, READY_A, { client: ANA, extra: { pitch: 99 } })).body;
  assert.equal(a.state.queue[0].pitch, 6);
  const patch = (client, pitch, h) => call('PATCH', `/rooms/${code}/queue/${a.item_id}`, { client, host: h, body: { pitch } });
  assert.equal((await patch(ANA, -2)).body.queue[0].pitch, -2);
  assert.equal((await patch(BIA, 1)).status, 403);
  assert.equal((await patch(BIA, -50, host)).body.queue[0].pitch, -6);
});

test('the lyrics offset: only the Host, it applies to the song in any Room, and it is limited', async () => {
  const one = await newRoom();
  const two = await newRoom();
  await add(one.code, READY_A);
  const put = (code, offset, h) => call('PUT', `/rooms/${code}/songs/${READY_A}/offset`, { host: h, body: { offset } });
  assert.equal((await put(one.code, 1, undefined)).status, 403);
  assert.equal((await put(one.code, 1.5, one.host)).body.queue[0].lyric_offset, 1.5);
  assert.equal((await put(one.code, 99, one.host)).body.queue[0].lyric_offset, 10);
  await add(two.code, READY_A); // another Room, the same song
  assert.equal((await call('GET', `/rooms/${two.code}`)).body.queue[0].lyric_offset, 10);
});

test('fair rotation (optional): the same person does not sing twice in a row', async () => {
  const run = async (fair) => {
    const { code, host } = await newRoom();
    if (fair) await call('PATCH', `/rooms/${code}`, { host, body: { fair: true } });
    const a1 = (await add(code, READY_A, { client: ANA })).body;
    await add(code, READY_B, { client: ANA });
    await add(code, READY_C, { client: BIA, name: 'Bia' });
    await app.rooms.tvEnded(code, a1.item_id);
    const { queue } = (await call('GET', `/rooms/${code}`)).body;
    assert.equal(queue[0].status, 'playing'); // the song playing always comes first, even with a higher position
    return queue[0].video_id;
  };
  assert.equal(await run(false), READY_B); // order of arrival
  assert.equal(await run(true), READY_C); // Bia before Ana's 2nd
});

test("the next Singer: follows the Queue's rule (ready, fair rotation) and goes away when nobody is waiting", async () => {
  const { code, host } = await newRoom();
  const nextOf = async () => {
    const state = (await call('GET', `/rooms/${code}`)).body;
    return state.queue.find((i) => i.id === state.next_item_id)?.added_by ?? null;
  };
  assert.equal(await nextOf(), null); // an empty Room

  const a1 = (await add(code, READY_A, { client: ANA, name: 'Ana' })).body;
  assert.equal(await nextOf(), null); // only the song playing is left

  await add(code, 'slowSong002', { client: ANA, name: 'Ana' }); // still being prepared: it does not count as "next"
  assert.equal(await nextOf(), null);

  await add(code, READY_B, { client: ANA, name: 'Ana' });
  await add(code, READY_C, { client: BIA, name: 'Bia' });
  assert.equal(await nextOf(), 'Ana'); // order of arrival: Ana's 2nd (the slow one is skipped)

  await call('PATCH', `/rooms/${code}`, { host, body: { fair: true } });
  assert.equal(await nextOf(), 'Bia'); // fair rotation: Bia before Ana's 2nd song
  assert.equal((await call('GET', `/rooms/${code}`)).body.next_item_id !== a1.item_id, true); // never the song playing
});

test('validation: the link, the lyrics, the identification and the limits', async () => {
  const { code } = await newRoom();
  assert.equal((await call('POST', `/rooms/${code}/queue`, { body: { url: 'https://example.com/x' } })).status, 400);
  assert.equal((await call('POST', `/rooms/${code}/queue`, { body: {} })).status, 400);
  assert.equal((await call('POST', `/rooms/${code}/queue`, { client: '', body: { video_id: READY_A } })).status, 400); // no X-Client-Id
  assert.equal((await call('POST', `/rooms/${code}/queue`, { client: 'curto', body: { video_id: READY_A } })).status, 400);
  assert.equal((await add(code, READY_A, { extra: { lyrics: { source: 'align' } } })).status, 400); // the text is required
  assert.equal((await call('POST', `/rooms/ZZZZ/queue`, { body: { video_id: READY_A } })).status, 404);
  assert.equal((await call('POST', `/rooms/${code}/queue`, { body: { url: `https://youtu.be/${READY_A}` } })).status, 201); // by link

  // the per-person limit: 20 songs WAITING (the one playing does not count)
  const other = await newRoom();
  for (let i = 0; i < 21; i++) assert.equal((await add(other.code, READY_A)).status, 201);
  const over = await add(other.code, READY_A);
  assert.equal(over.status, 409);
  assert.equal(over.body.error, 'too_many');
  assert.equal((await add(other.code, READY_B, { client: BIA })).status, 201); // another person can
});

test('the artist and title are required for a new song; the ones already ready (the Jukebox) need neither', async () => {
  const { code } = await newRoom();
  const raw = (body) => call('POST', `/rooms/${code}/queue`, { body });
  const refused = await raw({ video_id: 'novaMusica1', name: 'Ana' });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, 'artist_title_required');
  assert.equal((await raw({ video_id: 'novaMusica1', artist: 'Só o artista' })).status, 400);
  assert.equal((await raw({ video_id: 'novaMusica1', artist: '   ', title: 'x' })).status, 400); // spaces do not count
  assert.equal((await raw({ url: 'https://youtu.be/novaMusica1' })).status, 400); // nor by link
  assert.equal((await raw({ video_id: 'novaMusica1', artist: ' Faouzia ', title: ' Unethical ' })).status, 201);
  const job = jobs.queue.findLast((j) => j.video_id === 'novaMusica1');
  assert.deepEqual([job.payload.artist, job.payload.title], ['Faouzia', 'Unethical']); // without the spaces at the ends
  assert.equal((await raw({ video_id: READY_A })).status, 201); // the Jukebox: already ready, without artist/title
});

test('adding with chosen lyrics creates the job with that choice (and a cached song only changes its lyrics)', async () => {
  const { code } = await newRoom();
  await add(code, 'newSong0001', { extra: { lyrics: { source: 'lrclib' }, artist: 'Faouzia', title: 'Unethical', display_title: 'Faouzia - Unethical' } });
  const job = jobs.queue.findLast((j) => j.video_id === 'newSong0001');
  assert.deepEqual([job.payload.lyrics_source, job.payload.artist, job.payload.title], ['lrclib', 'Faouzia', 'Unethical']);
  const state = (await call('GET', `/rooms/${code}`)).body;
  assert.equal(state.queue[0].title, 'Faouzia - Unethical'); // what the person chose in the search, until the song is ready

  jobs.update('newSong0001', { status: 'needs_lyrics', error: 'sem letra' });
  const waiting = (await call('GET', `/rooms/${code}`)).body.queue[0].song;
  assert.deepEqual([waiting.status, waiting.error, waiting.ready], ['needs_lyrics', 'sem letra', false]);
});

test('persistence: Rooms and the Queue survive a restart (the same SQLite file)', async () => {
  const path = join(root, 'persist.db');
  const first = await openDatabase(path);
  const db = fixtures(first.orm);
  await db.createRoom('ABCD', 'tok', 1000);
  const id = await db.addItem({ room: 'ABCD', videoId: READY_A, addedBy: 'Ana', clientId: ANA, now: 1000 });
  await db.updateItem(id, { pitch: 2 });
  await db.updateRoom('ABCD', { fair: true });
  await first.close();

  // the API starts again on the same file
  const second = await buildApp({ config: { dbPath: path, publicDir: root }, storage: new LocalStorage(root), jobs });
  const state = await second.rooms.getState('ABCD', { clientId: ANA, hostToken: '' });
  assert.equal(state.fair, true);
  const [restored] = state.queue;
  assert.deepEqual([restored.id, restored.video_id, restored.pitch], [id, READY_A, 2]);
  assert.equal(await second.rooms.deleteInactiveRooms(2000), 1); // cleaning up idle Rooms
  await assert.rejects(second.rooms.getState('ABCD', { clientId: ANA, hostToken: '' }), { status: 404 });
  assert.equal(await second.orm.em.fork().count(QueueItem, { room: 'ABCD' }), 0); // the items go with them (ON DELETE CASCADE)
  await second.close();
});

test('a real WebSocket: the initial state, the TV reports the end, the position goes only to the phones', async () => {
  const { code, host } = await newRoom();
  const a = (await add(code, READY_A)).body;
  await add(code, READY_B);

  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address();
  const open = (query) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/rooms/ws?code=${code}&${query}`);
    const messages = [];
    ws.on('message', (data) => messages.push(JSON.parse(String(data))));
    ws.on('open', () => resolve({ ws, messages }));
    ws.on('error', reject);
  });
  const until = async (fn, label) => {
    for (let i = 0; i < 100; i++) {
      const value = fn();
      if (value) return value;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.fail(`timed out: ${label}`);
  };

  const controller = await open(`role=controller&client=${ANA}&host=${host}`);
  const first = await until(() => controller.messages.find((m) => m.type === 'state'), 'initial state');
  assert.equal(first.state.me.is_host, true);
  assert.equal(first.state.queue[0].mine, true);
  assert.equal(first.state.tv_connected, false);

  const tv = await open(`role=tv&client=${BIA}`);
  await until(() => controller.messages.findLast((m) => m.type === 'state')?.state.tv_connected, 'TV connected');

  tv.ws.send(JSON.stringify({ type: 'position', item_id: a.item_id, ms: 12345 }));
  const position = await until(() => controller.messages.find((m) => m.type === 'position'), 'position');
  assert.equal(position.ms, 12345);
  assert.equal(tv.messages.some((m) => m.type === 'position'), false); // the TV does not get its own position

  controller.ws.send(JSON.stringify({ type: 'ended', item_id: a.item_id })); // a phone does not have that power: ignored
  tv.ws.send(JSON.stringify({ type: 'ended', item_id: a.item_id }));
  const advanced = await until(
    () => controller.messages.findLast((m) => m.type === 'state' && m.state.queue.length === 1 && m.state.queue[0].video_id === READY_B),
    'queue advanced',
  );
  assert.equal(advanced.state.queue[0].status, 'playing');

  tv.ws.close();
  await until(() => controller.messages.findLast((m) => m.type === 'state')?.state.tv_connected === false, 'TV disconnected');
  controller.ws.close();

  const bad = new WebSocket(`ws://127.0.0.1:${port}/api/rooms/ws?code=ZZZZ&role=tv`);
  const code1008 = await new Promise((resolve) => bad.on('close', (c) => resolve(c)));
  assert.equal(code1008, 1008); // a Room that does not exist
});

test("scoring (optional): only the Host turns it on; the TV's Score counts only for the song playing and goes to the scoreboard", async () => {
  const { code, host } = await newRoom();
  assert.equal((await call('PATCH', `/rooms/${code}`, { client: BIA, body: { scoring: true } })).status, 403);
  assert.equal((await call('PATCH', `/rooms/${code}`, { host, body: {} })).status, 400);
  const a = (await add(code, READY_A, { client: ANA })).body;
  await app.rooms.tvScore(code, a.item_id, 80); // off: ignored
  assert.deepEqual((await call('GET', `/rooms/${code}`)).body.scoreboard, []);

  const on = await call('PATCH', `/rooms/${code}`, { host, body: { scoring: true } });
  assert.equal(on.body.scoring, true);
  assert.equal(on.body.fair, false); // one setting does not touch the other

  await app.rooms.tvScore(code, a.item_id, 101); // outside 0..100: ignored
  await app.rooms.tvScore(code, a.item_id, 87.5); // not an integer: ignored
  await app.rooms.tvScore(code, a.item_id, 87);
  await app.rooms.tvEnded(code, a.item_id);
  const b = (await add(code, READY_B, { client: BIA, name: 'Bia' })).body;
  await app.rooms.tvScore(code, b.item_id, 95);
  const { scoreboard } = (await call('GET', `/rooms/${code}`)).body;
  assert.deepEqual(scoreboard.map((r) => [r.name, r.score]), [['Bia', 95], ['Ana', 87]]);
});

test("the Voice in the speakers (the TV's microphone): only the Host turns it on and sets its volume (0 to 100); it starts off and low", async () => {
  const { code, host } = await newRoom();
  const start = (await call('GET', `/rooms/${code}`)).body;
  assert.deepEqual([start.voice, start.voice_volume], [false, 40]); // off by default, low volume
  assert.equal((await call('PATCH', `/rooms/${code}`, { client: BIA, body: { voice: true } })).status, 403);
  assert.equal((await call('PATCH', `/rooms/${code}`, { client: BIA, body: { voice_volume: 90 } })).status, 403);

  const on = await call('PATCH', `/rooms/${code}`, { host, body: { voice: true } });
  assert.deepEqual([on.body.voice, on.body.voice_volume, on.body.scoring, on.body.fair], [true, 40, false, false]); // one setting does not touch the others
  const louder = await call('PATCH', `/rooms/${code}`, { host, body: { voice_volume: 75 } });
  assert.deepEqual([louder.body.voice, louder.body.voice_volume], [true, 75]);
  for (const bad of [101, -1, 50.5, 'alto']) assert.equal((await call('PATCH', `/rooms/${code}`, { host, body: { voice_volume: bad } })).status, 400, String(bad));
  assert.equal((await call('GET', `/rooms/${code}`)).body.voice_volume, 75); // the invalid values changed nothing

  const off = await call('PATCH', `/rooms/${code}`, { host, body: { voice: false } });
  assert.deepEqual([off.body.voice, off.body.voice_volume], [false, 75]); // turning it off keeps the chosen volume
  const other = await newRoom();
  assert.equal((await call('GET', `/rooms/${other.code}`)).body.voice, false); // and it is per Room
});

test('the reference melody shows only when it exists in the cache', async () => {
  const dir = join(root, 'cache', READY_B);
  await writeFile(join(dir, 'melody.json'), '{"hop":0.05,"midi":[]}');
  const { code } = await newRoom();
  const a = (await add(code, READY_A)).body;
  await add(code, READY_B);
  const { queue } = (await call('GET', `/rooms/${code}`)).body;
  assert.equal(queue.find((i) => i.video_id === READY_A).song.media.melody, null);
  assert.match(queue.find((i) => i.video_id === READY_B).song.media.melody, /melody\.json$/);
  assert.ok(a.item_id);
});

test('seeking in the song: only the Host, only with a song playing, and the TV is the one that does it', async () => {
  const { code, host } = await newRoom();
  const tv = await fakeConn(code, { role: 'tv' });
  const ctrl = await fakeConn(code);
  assert.equal((await call('POST', `/rooms/${code}/player/seek`, { host, body: { seconds: 10 } })).status, 200); // nothing playing: ignored
  const a = (await add(code, READY_A)).body;
  assert.equal((await call('POST', `/rooms/${code}/player/seek`, { client: BIA, body: { seconds: 10 } })).status, 403);
  assert.equal((await call('POST', `/rooms/${code}/player/seek`, { host, body: { seconds: 999 } })).status, 400);
  assert.equal((await call('POST', `/rooms/${code}/player/seek`, { host, body: { seconds: -10 } })).status, 200);
  assert.deepEqual(tv.sent.filter((m) => m.type === 'seek'), [{ type: 'seek', item_id: a.item_id, seconds: -10 }]);
  assert.equal(ctrl.sent.filter((m) => m.type === 'seek').length, 0);
});

test("moving the song's position: the dragged bar sends the target point (`to`), exclusive with the relative jump", async () => {
  const { code, host } = await newRoom();
  const tv = await fakeConn(code, { role: 'tv' });
  const a = (await add(code, READY_A)).body;
  const seek = (body, opts = { host }) => call('POST', `/rooms/${code}/player/seek`, { ...opts, body });
  assert.equal((await seek({ to: 95.5 })).status, 200);
  assert.equal((await seek({ to: 0 })).status, 200); // back to the start
  assert.equal((await seek({ to: -1 })).status, 400);
  assert.equal((await seek({ to: 99_999 })).status, 400);
  assert.equal((await seek({ to: 10, seconds: 5 })).status, 400); // one or the other
  assert.equal((await seek({})).status, 400);
  assert.equal((await seek({ to: 30 }, { client: BIA })).status, 403); // only the Host
  assert.deepEqual(
    tv.sent.filter((m) => m.type === 'seek'),
    [{ type: 'seek', item_id: a.item_id, to: 95.5 }, { type: 'seek', item_id: a.item_id, to: 0 }],
  );
});

test('Backing vocals: the level (0..100) belongs to whoever chose the song (or the Host), applies per item and coexists with the Key', async () => {
  const { code, host } = await newRoom();
  const a = (await add(code, READY_A, { client: ANA })).body;
  const setting = (client, body, opts = {}) => call('PATCH', `/rooms/${code}/queue/${a.item_id}`, { client, body, ...opts });
  const itemOf = async () => (await call('GET', `/rooms/${code}`)).body.queue.find((i) => i.id === a.item_id);

  assert.equal((await itemOf()).backing, 0); // default: off
  assert.equal((await setting(ANA, { backing: 40 })).status, 200);
  assert.equal((await itemOf()).backing, 40);
  assert.equal((await itemOf()).pitch, 0); // one setting does not touch the other

  await setting(ANA, { backing: 250 }); // above the limit: becomes 100
  assert.equal((await itemOf()).backing, 100);
  await setting(ANA, { backing: -5 });
  assert.equal((await itemOf()).backing, 0);

  assert.equal((await setting(ANA, { pitch: 2, backing: 30 })).status, 200); // both at once
  assert.deepEqual([(await itemOf()).pitch, (await itemOf()).backing], [2, 30]);

  assert.equal((await setting(BIA, { backing: 90 })).status, 403); // someone else does not touch it
  assert.equal((await setting(BIA, { backing: 90 }, { host })).status, 200); // the Host does
  assert.equal((await itemOf()).backing, 90);
  assert.equal((await setting(ANA, {})).status, 400); // at least one setting is needed
  assert.equal((await setting(ANA, { backing: 'muito' })).status, 400);
  assert.equal((await setting(ANA, { backing: 1.5 })).status, 400);
});

test('Backing vocals: the backing.mp3 URL shows only on the songs that have it', async () => {
  await writeFile(join(root, 'cache', READY_B, 'backing.mp3'), 'apoio');
  const { code } = await newRoom();
  await add(code, READY_A);
  await add(code, READY_B);
  const { queue } = (await call('GET', `/rooms/${code}`)).body;
  assert.equal(queue.find((i) => i.video_id === READY_A).song.media.backing, null);
  assert.match(queue.find((i) => i.video_id === READY_B).song.media.backing, /backing\.mp3$/);
});

test('the Original voice guide: the level (0..100) follows the same rules as the Backing vocals and does not touch the others', async () => {
  const { code, host } = await newRoom();
  const a = (await add(code, READY_A, { client: ANA })).body;
  const setting = (client, body, opts = {}) => call('PATCH', `/rooms/${code}/queue/${a.item_id}`, { client, body, ...opts });
  const itemOf = async () => (await call('GET', `/rooms/${code}`)).body.queue.find((i) => i.id === a.item_id);

  assert.equal((await itemOf()).guide, 0); // default: off
  assert.equal((await setting(ANA, { guide: 35 })).status, 200);
  assert.deepEqual([(await itemOf()).guide, (await itemOf()).backing, (await itemOf()).pitch], [35, 0, 0]);
  await setting(ANA, { guide: 300 });
  assert.equal((await itemOf()).guide, 100);
  assert.equal((await setting(ANA, { backing: 20, guide: 60 })).status, 200);
  assert.deepEqual([(await itemOf()).backing, (await itemOf()).guide], [20, 60]);
  assert.equal((await setting(BIA, { guide: 10 })).status, 403);
  assert.equal((await setting(BIA, { guide: 10 }, { host })).status, 200);
  assert.equal((await itemOf()).guide, 10);
  assert.equal((await setting(ANA, { guide: 'alto' })).status, 400);
});

test('the Melody guide: only the Host turns it on, it starts off, and one setting does not touch the others', async () => {
  const { code, host } = await newRoom();
  assert.equal((await call('GET', `/rooms/${code}`)).body.melody_bars, false);
  assert.equal((await call('PATCH', `/rooms/${code}`, { client: BIA, body: { melody_bars: true } })).status, 403);
  const on = await call('PATCH', `/rooms/${code}`, { host, body: { melody_bars: true } });
  assert.deepEqual([on.body.melody_bars, on.body.scoring, on.body.voice, on.body.fair], [true, false, false, false]);
  assert.equal((await call('PATCH', `/rooms/${code}`, { host, body: { scoring: true } })).body.melody_bars, true); // another setting does not turn it off
  assert.equal((await call('PATCH', `/rooms/${code}`, { host, body: { melody_bars: 'sim' } })).status, 400);
  assert.equal((await call('PATCH', `/rooms/${code}`, { host, body: { melody_bars: false } })).body.melody_bars, false);
});

test('playing a song records when it played and keeps its lyrics offset', async () => {
  const { code, host } = await newRoom();
  await add(code, READY_A); // plays now
  await add(code, READY_B);
  assert.equal((await call('PUT', `/rooms/${code}/songs/${READY_B}/offset`, { host, body: { offset: 2.5 } })).status, 200);
  await call('POST', `/rooms/${code}/player/skip`, { host }); // READY_B goes on
  const state = (await call('GET', `/rooms/${code}`)).body;
  assert.deepEqual([state.queue[0].video_id, state.queue[0].status, state.queue[0].lyric_offset], [READY_B, 'playing', 2.5]);
  const row = await fixtures(app.orm).songSettings(READY_B);
  assert.equal(row.lyricOffset, 2.5);
  assert.ok(row.lastPlayedAt > 0);
});
