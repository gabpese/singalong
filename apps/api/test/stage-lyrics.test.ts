// The TV passes the lyrics on to the singers' Stage (a phone), which cannot reach the songs kept on the owner's computer.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { buildApp } from '../dist/app.js';
import { createMemoryJobStore } from '../dist/jobs.js';
import { RoomsGateway } from '../dist/rooms/rooms.gateway.js';
import { sanitizeCues } from '../dist/rooms/rooms.js';
import { LocalStorage } from '../dist/storage.js';

const SONG = 'songAlpha01';
const ANA = 'client-ana-0001';
const CUES = [{ start: 1, end: 4, text: 'Primeira linha', words: [[1, 2], [2, 4]] }, { start: 5, end: 8, text: 'Segunda linha' }];
let app;

before(async () => {
  const root = await mkdtemp(join(tmpdir(), 'singalong-stage-'));
  const dir = join(root, 'cache', SONG);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'instrumental.mp3'), Buffer.from('ID3x'));
  await writeFile(join(dir, 'lyrics.json'), JSON.stringify(CUES));
  await writeFile(join(dir, 'meta.json'), JSON.stringify({ video_id: SONG, title: 'T', artist: 'A' }));
  app = await buildApp({
    config: { publicDir: root, rateLimits: { createRoom: { max: 1e6, windowMs: 60_000 }, addToQueue: { max: 1e6, windowMs: 60_000 } } },
    storage: new LocalStorage(root),
    jobs: createMemoryJobStore(),
  });
  await app.ready();
});

after(() => app.close());

/** A device connected through the gateway, as a real socket would be (the gateway is the one that knows who is the TV). */
async function fakeConn(code, role) {
  const sent = [];
  const socket = { readyState: 1, send: (data) => sent.push(JSON.parse(data)), ping() {}, terminate() {}, close() {}, on() {} };
  const gateway = new RoomsGateway(app.rooms);
  gateway.handleConnection(socket, { url: `/api/rooms/ws?code=${code}&role=${role}&client=${ANA}` });
  await socket.joined;
  return { gateway, socket, sent, lyrics: () => sent.filter((m) => m.type === 'lyrics') };
}

async function roomPlaying() {
  const room = (await app.inject({ method: 'POST', url: '/api/rooms' })).json();
  const add = await app.inject({ method: 'POST', url: `/api/rooms/${room.code}/queue`, headers: { 'x-client-id': ANA }, payload: { video_id: SONG, name: 'Ana', artist: 'A', title: 'T' } });
  return { code: room.code, itemId: add.json().item_id };
}

const tvSends = (conn, message) => conn.gateway.lyrics(conn.socket, message);

test('the lyrics the TV sends reach the phones (not the TV itself), and whoever joins later gets them', async () => {
  const { code, itemId } = await roomPlaying();
  const phone = await fakeConn(code, 'controller');
  const tv = await fakeConn(code, 'tv');
  await tvSends(tv, { type: 'lyrics', item_id: itemId, cues: CUES });
  assert.deepEqual(phone.lyrics(), [{ type: 'lyrics', item_id: itemId, cues: CUES }]);
  assert.deepEqual(tv.lyrics(), []);

  const late = await fakeConn(code, 'controller'); // the Stage opens after the song started
  assert.deepEqual(late.lyrics(), [{ type: 'lyrics', item_id: itemId, cues: CUES }]);
  const anotherTv = await fakeConn(code, 'tv');
  assert.deepEqual(anotherTv.lyrics(), []);
});

test('only the TV sends the lyrics, only for the song playing, and only when well formed', async () => {
  const { code, itemId } = await roomPlaying();
  const phone = await fakeConn(code, 'controller');
  const other = await fakeConn(code, 'controller');
  await tvSends(other, { type: 'lyrics', item_id: itemId, cues: CUES }); // a phone does not have that power
  const tv = await fakeConn(code, 'tv');
  await tvSends(tv, { type: 'lyrics', item_id: itemId + 99, cues: CUES }); // not the current song
  await tvSends(tv, { type: 'lyrics', item_id: itemId, cues: [{ start: 'x', end: 2, text: 'a' }] });
  await tvSends(tv, { type: 'lyrics', item_id: itemId, cues: 'lixo' });
  assert.deepEqual(phone.lyrics(), []);
  assert.deepEqual((await fakeConn(code, 'controller')).lyrics(), []); // nothing was kept
});

test('sanitizeCues cleans, limits and refuses what is no good', () => {
  assert.deepEqual(sanitizeCues([{ start: 1, end: 2, text: 'oi', extra: 'x', words: [[1, 2]] }]), [{ start: 1, end: 2, text: 'oi', words: [[1, 2]] }]);
  assert.deepEqual(sanitizeCues([{ start: 1, end: 2, text: 'oi', words: [[1, 'a']] }]), [{ start: 1, end: 2, text: 'oi' }]); // bad words: only that line
  assert.equal(sanitizeCues(null), null);
  assert.equal(sanitizeCues(new Array(3001).fill({ start: 0, end: 1, text: 'a' })), null);
  assert.equal(sanitizeCues([{ start: 0, end: 1, text: 'a'.repeat(401) }]), null);
  assert.equal(sanitizeCues(new Array(2000).fill({ start: 0, end: 1, text: 'a'.repeat(300) })), null); // too big in total
  assert.deepEqual(sanitizeCues([]), []);
});
