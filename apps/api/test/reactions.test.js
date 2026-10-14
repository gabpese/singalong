// Reações dos celulares (aplausos, fogo...): só as permitidas, com limite por conexão, e vão para a TV e para quem a assiste.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { buildApp } from '../src/app.js';
import { createMemoryJobStore } from '../src/jobs.js';
import { createBucket, REACTION_KINDS } from '../src/reactions.js';
import { LocalStorage } from '../src/storage.js';

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
  app = buildApp({
    config: { publicDir: root, rateLimits: { createRoom: { max: 1e6, windowMs: 60_000 }, addToQueue: { max: 1e6, windowMs: 60_000 } } },
    storage: new LocalStorage(root),
    jobs: createMemoryJobStore(),
  });
  await app.ready();
});

after(() => app.close());

function fakeConn(code, role, client = ANA, name = '') {
  const sent = [];
  const socket = { readyState: 1, send: (data) => sent.push(JSON.parse(data)), ping() {}, terminate() {} };
  const session = app.rooms.connect(code, { socket, role, clientId: client, hostToken: '', name });
  return { session, sent, reactions: () => sent.filter((m) => m.type === 'reaction') };
}

const send = (code, conn, message) => app.rooms.onMessage(code, conn.session.conn, JSON.stringify(message));
const newRoom = async () => (await app.inject({ method: 'POST', url: '/api/rooms' })).json().code;

test('o balde de fichas deixa uma rajada, descarta o excesso e volta a encher com o tempo', () => {
  const bucket = createBucket({ capacity: 3, perSecond: 2 });
  assert.deepEqual([0, 0, 0, 0, 0].map(() => bucket.take(1000)), [true, true, true, false, false]);
  assert.equal(bucket.take(1500), true); // meio segundo: 1 ficha
  assert.equal(bucket.take(1500), false);
  assert.equal(bucket.take(60_000), true); // muito tempo depois: cheio de novo, nunca acima da capacidade
  assert.deepEqual([0, 0].map(() => bucket.take(60_000)), [true, true]);
  assert.equal(bucket.take(60_000), false);
});

test('uma reação chega à TV e aos outros celulares, com o nome de quem mandou', async () => {
  const code = await newRoom();
  const tv = fakeConn(code, 'tv', 'tv-client-0001');
  const ana = fakeConn(code, 'controller', ANA, 'Ana');
  const bia = fakeConn(code, 'controller', BIA, 'Bia');
  send(code, ana, { type: 'reaction', kind: 'clap' });
  assert.deepEqual(tv.reactions(), [{ type: 'reaction', kind: 'clap', name: 'Ana' }]);
  assert.deepEqual(bia.reactions(), [{ type: 'reaction', kind: 'clap', name: 'Ana' }]);
  assert.equal(ana.reactions().length, 1); // quem mandou também vê (na aba TV)
  assert.equal(REACTION_KINDS.length, 5);
});

test('só as reações da lista valem, e só os celulares as mandam (a TV não)', async () => {
  const code = await newRoom();
  const tv = fakeConn(code, 'tv', 'tv-client-0001');
  const ana = fakeConn(code, 'controller', ANA, 'Ana');
  for (const kind of ['bomb', '', 42, null, undefined, '<img src=x>']) send(code, ana, { type: 'reaction', kind });
  send(code, tv, { type: 'reaction', kind: 'fire' });
  assert.deepEqual(tv.reactions(), []);
  assert.deepEqual(ana.reactions(), []);
  send(code, ana, '{ não é json');
  app.rooms.onMessage(code, ana.session.conn, '{ não é json'); // lixo no socket não derruba nada
  send(code, ana, { type: 'reaction', kind: 'fire' });
  assert.equal(tv.reactions().length, 1);
});

test('quem aperta sem parar é limitado por conexão; outra pessoa não é afetada', async () => {
  const code = await newRoom();
  const tv = fakeConn(code, 'tv', 'tv-client-0001');
  const ana = fakeConn(code, 'controller', ANA, 'Ana');
  const bia = fakeConn(code, 'controller', BIA, 'Bia');
  for (let i = 0; i < 40; i++) send(code, ana, { type: 'reaction', kind: 'party' });
  const fromAna = tv.reactions().filter((m) => m.name === 'Ana').length;
  assert.ok(fromAna >= 1 && fromAna <= 8, `da Ana: ${fromAna}`); // a rajada inicial, e nada além
  send(code, bia, { type: 'reaction', kind: 'heart' });
  assert.equal(tv.reactions().filter((m) => m.name === 'Bia').length, 1);
});
