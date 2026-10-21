// The owner's statistics: what played in the Rooms of a computer's Sessions, with the history kept after the Room is gone.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { buildApp } from '../dist/app.js';
import { createMemoryJobStore } from '../dist/jobs.js';
import { RoomService } from '../dist/rooms/room.service.js';
import { RoomsGateway } from '../dist/rooms/rooms.gateway.js';
import { LocalStorage } from '../dist/storage.js';
import { fixtures, openDatabase } from './fixtures.ts';

const SONGS = ['statSongA01', 'statSongB02', 'statSongC03'];
const ANA = 'client-ana-0001';
const BIA = 'client-bia-0001';
const BIG = { max: 1e6, windowMs: 60_000 };
let app;

before(async () => {
  const root = await mkdtemp(join(tmpdir(), 'singalong-stats-'));
  for (const id of SONGS) {
    const dir = join(root, 'cache', id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'instrumental.mp3'), Buffer.from('ID3x'));
    await writeFile(join(dir, 'lyrics.json'), '[]');
    await writeFile(join(dir, 'meta.json'), JSON.stringify({ video_id: id, title: `Música ${id.slice(8)}`, artist: `Artista ${id.slice(8)}`, duration: 100 }));
  }
  app = await buildApp({
    config: { publicDir: root, adminToken: 'adm', rateLimits: { pair: BIG, createRoom: BIG, search: BIG, addToQueue: BIG } },
    storage: new LocalStorage(root),
    jobs: createMemoryJobStore(),
  });
  await app.ready();
});

after(() => app.close());

const agentCall = (method, url, headers, payload) => app.inject({ method, url: `/agent/v1${url}`, headers, payload });

/** A paired computer, with a Session and a Room. */
async function owner() {
  const start = await agentCall('POST', '/pair/start', { 'x-admin-token': 'adm' }, {});
  const done = await agentCall('POST', '/pair/complete', {}, { code: start.json().code, name: 'PC do teste' });
  const headers = { authorization: `Bearer ${done.json().token}` };
  const session = (await agentCall('POST', '/sessions', headers, { display_name: 'Dono' })).json();
  const room = (await agentCall('POST', `/sessions/${session.id}/rooms`, headers, {})).json();
  return { headers, session, room };
}

const add = (code, videoId, client, name) =>
  app.inject({ method: 'POST', url: `/api/rooms/${code}/queue`, headers: { 'x-client-id': client }, payload: { video_id: videoId, name, artist: 'A', title: 'T' } });

/** A device connected through the gateway, as a real socket would be. */
async function fakeConn(code, role, client) {
  const socket = { readyState: 1, send() {}, ping() {}, terminate() {}, close() {}, on() {} };
  const gateway = new RoomsGateway(app.rooms);
  gateway.handleConnection(socket, { url: `/api/rooms/ws?code=${code}&role=${role}&client=${client}${role === 'controller' ? '&name=Plateia' : ''}` });
  await socket.joined;
  return { gateway, socket };
}

/** What the socket sends: the gateway's handler of that message type (hello, reaction, score, ended...). */
const msg = (conn, message) => conn.gateway[message.type](conn.socket, message);
const state = async (code) => (await app.inject({ method: 'GET', url: `/api/rooms/${code}`, headers: { 'x-client-id': ANA } })).json();
const stats = (headers, query = '') => agentCall('GET', `/stats${query}`, headers);

test('after songs were sung, the owner sees the totals, the most played, who sang the most and what got the most applause', async () => {
  const { headers, room } = await owner();
  await app.inject({ method: 'PATCH', url: `/api/rooms/${room.code}`, headers: { 'x-client-id': ANA, 'x-host-token': room.host_token }, payload: { scoring: true } });
  await add(room.code, SONGS[0], ANA, 'Ana');
  await add(room.code, SONGS[1], BIA, 'Bia');
  await add(room.code, SONGS[0], BIA, 'Bia'); // the same song a second time
  await add(room.code, SONGS[2], ANA, 'Ana'); // this one will be skipped

  const tv = await fakeConn(room.code, 'tv', 'tv-client-0001');
  const phone = await fakeConn(room.code, 'controller', 'client-caio-0001');
  const playNext = async ({ score, cheers, end = true }) => {
    const current = (await state(room.code)).current_item_id;
    assert.ok(current, 'a song is playing');
    for (let i = 0; i < cheers; i++) await msg(phone, { type: 'reaction', kind: 'clap' });
    if (score !== undefined) await msg(tv, { type: 'score', item_id: current, score });
    if (end) {
      await msg(tv, { type: 'ended', item_id: current });
      await new Promise((resolve) => setTimeout(resolve, 30));
      await app.rooms.tick();
    }
  };

  await playNext({ score: 80, cheers: 4 }); // Ana, song A
  await playNext({ score: 60, cheers: 1 }); // Bia, song B
  await playNext({ score: 100, cheers: 0 }); // Bia, song A again
  const skipped = await app.inject({ method: 'POST', url: `/api/rooms/${room.code}/player/skip`, headers: { 'x-client-id': ANA, 'x-host-token': room.host_token } });
  assert.equal(skipped.statusCode, 200); // the fourth (Ana, song C) is skipped

  const res = await stats(headers);
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.days, 30);
  assert.deepEqual(body.totals, { songs: 3, singers: 2, sessions: 1, cheers: 5, avg_score: 80, duets: 0, skipped: 1 });
  assert.deepEqual(body.top_songs.map((s) => [s.video_id, s.plays]), [[SONGS[0], 2], [SONGS[1], 1]]); // the most played first
  assert.equal(body.top_songs[0].avg_score, 90);
  assert.deepEqual(body.top_singers.map((s) => [s.name, s.songs]), [['Bia', 2], ['Ana', 1]]);
  assert.deepEqual(body.most_cheered.map((s) => [s.video_id, s.cheers]), [[SONGS[0], 4], [SONGS[1], 1]]);
  assert.equal(body.by_day.length, 1);
  assert.equal(body.by_day[0].songs, 3);
  // nothing that identifies anyone: neither the client_id nor the person's internal key
  assert.ok(!JSON.stringify(body).includes(ANA) && !JSON.stringify(body).includes('singer_key'));
});

test('each owner sees only their own Rooms; without a token it is 401; the days are validated', async () => {
  const one = await owner();
  const other = await owner();
  await add(one.room.code, SONGS[1], ANA, 'Ana');
  const tv = await fakeConn(one.room.code, 'tv', 'tv-client-0002');
  const current = (await state(one.room.code)).current_item_id;
  await msg(tv, { type: 'ended', item_id: current });
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal((await stats(one.headers)).json().totals.songs, 1);
  assert.deepEqual((await stats(other.headers)).json().totals, { songs: 0, singers: 0, sessions: 0, cheers: 0, avg_score: null, duets: 0, skipped: 0 });
  assert.equal((await stats({})).statusCode, 401);
  assert.equal((await stats(one.headers, '?days=0')).statusCode, 400);
  assert.equal((await stats(one.headers, '?days=366')).statusCode, 400);
  assert.equal((await stats(one.headers, '?days=7')).json().days, 7);
});

test("the history outlives the Room: deleting the Room does not delete the owner's statistics", async () => {
  const { headers, room } = await owner();
  await add(room.code, SONGS[0], ANA, 'Ana');
  const tv = await fakeConn(room.code, 'tv', 'tv-client-0003');
  await msg(tv, { type: 'ended', item_id: (await state(room.code)).current_item_id });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const before = (await stats(headers)).json().totals.songs;
  assert.equal(before, 1);

  // the database deletes Rooms idle for 24 h; the history stays (in a database of this test's own, so the pruning cannot reach the others)
  const { orm, close } = await openDatabase();
  const rooms = new RoomService({ orm, songs: {} });
  const db = fixtures(orm);
  await db.createDevice({ id: 'd1', name: 'PC', tokenHash: 'h', now: Date.now() });
  await db.logPlay({ device: 'd1', sessionId: 's1', videoId: SONGS[0], singer: 'Ana', singerKey: 'k1', outcome: 'done', endedAt: Date.now() });
  await db.createRoom('ZZZZ', 'tok', Date.now() - 3 * 24 * 3600 * 1000);
  assert.equal(await rooms.deleteInactiveRooms(Date.now() - 24 * 3600 * 1000), 1);
  assert.equal((await rooms.statsFor('d1', 0)).totals.songs, 1);
  assert.equal(await rooms.prunePlayLog(Date.now() + 1000), 1); // old history is pruned by age
  assert.equal((await rooms.statsFor('d1', 0)).totals.songs, 0);
  await close();
});
