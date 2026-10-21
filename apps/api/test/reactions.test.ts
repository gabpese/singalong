// The phones' reactions (applause, fire...): only the allowed ones, limited per connection, and they reach the TV and whoever watches it.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { buildApp } from '../dist/app.js';
import { createMemoryJobStore } from '../dist/jobs.js';
import { createBucket, REACTION_KINDS } from '../dist/rooms/reactions.js';
import { parseRoomMessage } from '../dist/rooms/rooms.gateway.js';
import { LocalStorage } from '../dist/storage.js';

const SONG = 'songAlpha01';
const ANA = 'client-ana-0001';
const BIA = 'client-bia-0001';
let app;

before(async () => {
  const root = await mkdtemp(join(tmpdir(), 'singalong-react-'));
  const dir = join(root, 'cache', SONG);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'instrumental.mp3'), Buffer.from('ID3x'));
  await writeFile(join(dir, 'lyrics.json'), '[]');
  await writeFile(join(dir, 'meta.json'), JSON.stringify({ video_id: SONG, title: 'T', artist: 'A' }));
  app = await buildApp({
    config: { publicDir: root, rateLimits: { createRoom: { max: 1e6, windowMs: 60_000 }, addToQueue: { max: 1e6, windowMs: 60_000 } } },
    storage: new LocalStorage(root),
    jobs: createMemoryJobStore(),
  });
  await app.ready();
});

after(() => app.close());

async function fakeConn(code, role, client = ANA, name = '') {
  const sent = [];
  const socket = { readyState: 1, send: (data) => sent.push(JSON.parse(data)), ping() {}, terminate() {} };
  const session = await app.rooms.connect(code, { socket, role, clientId: client, hostToken: '', name });
  return { session, sent, reactions: () => sent.filter((m) => m.type === 'reaction') };
}

/** What the gateway does with what a socket sends: it reads the message and hands a reaction to the service. */
const send = async (conn, raw) => {
  const message = parseRoomMessage(typeof raw === 'string' ? raw : JSON.stringify(raw));
  if (message?.event === 'reaction') await app.rooms.react(conn.session.conn, message.data.kind);
};
const newRoom = async () => (await app.inject({ method: 'POST', url: '/api/rooms' })).json().code;

test('the token bucket lets a burst through, drops the excess and refills over time', () => {
  const bucket = createBucket({ capacity: 3, perSecond: 2 });
  assert.deepEqual([0, 0, 0, 0, 0].map(() => bucket.take(1000)), [true, true, true, false, false]);
  assert.equal(bucket.take(1500), true); // half a second: 1 token
  assert.equal(bucket.take(1500), false);
  assert.equal(bucket.take(60_000), true); // long after: full again, never above capacity
  assert.deepEqual([0, 0].map(() => bucket.take(60_000)), [true, true]);
  assert.equal(bucket.take(60_000), false);
});

test("a reaction reaches the TV and the other phones, with the sender's name", async () => {
  const code = await newRoom();
  const tv = await fakeConn(code, 'tv', 'tv-client-0001');
  const ana = await fakeConn(code, 'controller', ANA, 'Ana');
  const bia = await fakeConn(code, 'controller', BIA, 'Bia');
  await send(ana, { type: 'reaction', kind: 'clap' });
  assert.deepEqual(tv.reactions(), [{ type: 'reaction', kind: 'clap', name: 'Ana' }]);
  assert.deepEqual(bia.reactions(), [{ type: 'reaction', kind: 'clap', name: 'Ana' }]);
  assert.equal(ana.reactions().length, 1); // the sender sees it too (on the TV tab)
  assert.equal(REACTION_KINDS.length, 5);
});

test('only the listed reactions count, and only phones send them (not the TV)', async () => {
  const code = await newRoom();
  const tv = await fakeConn(code, 'tv', 'tv-client-0001');
  const ana = await fakeConn(code, 'controller', ANA, 'Ana');
  for (const kind of ['bomb', '', 42, null, undefined, '<img src=x>']) await send(ana, { type: 'reaction', kind });
  await send(tv, { type: 'reaction', kind: 'fire' });
  assert.deepEqual(tv.reactions(), []);
  assert.deepEqual(ana.reactions(), []);
  await send(ana, '{ não é json'); // garbage on the socket breaks nothing
  assert.equal(parseRoomMessage('{ não é json'), undefined);
  assert.equal(parseRoomMessage('"só um texto"'), undefined);
  await send(ana, { type: 'reaction', kind: 'fire' });
  assert.equal(tv.reactions().length, 1);
});

test('someone pressing nonstop is limited per connection; another person is not affected', async () => {
  const code = await newRoom();
  const tv = await fakeConn(code, 'tv', 'tv-client-0001');
  const ana = await fakeConn(code, 'controller', ANA, 'Ana');
  const bia = await fakeConn(code, 'controller', BIA, 'Bia');
  for (let i = 0; i < 40; i++) await send(ana, { type: 'reaction', kind: 'party' });
  const fromAna = tv.reactions().filter((m) => m.name === 'Ana').length;
  assert.ok(fromAna >= 1 && fromAna <= 8, `da Ana: ${fromAna}`); // the initial burst, and nothing more
  await send(bia, { type: 'reaction', kind: 'heart' });
  assert.equal(tv.reactions().filter((m) => m.name === 'Bia').length, 1);
});
