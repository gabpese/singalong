// A TV repassa a letra ao palco dos cantores (celular), que não alcança as músicas guardadas no computador do dono.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { buildApp } from '../src/app.js';
import { createMemoryJobStore } from '../src/jobs.js';
import { sanitizeCues } from '../src/rooms.js';
import { LocalStorage } from '../src/storage.js';

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
  app = buildApp({
    config: { publicDir: root, rateLimits: { createRoom: { max: 1e6, windowMs: 60_000 }, addToQueue: { max: 1e6, windowMs: 60_000 } } },
    storage: new LocalStorage(root),
    jobs: createMemoryJobStore(),
  });
  await app.ready();
});

after(() => app.close());

function fakeConn(code, role) {
  const sent = [];
  const socket = { readyState: 1, send: (data) => sent.push(JSON.parse(data)), ping() {}, terminate() {} };
  const session = app.rooms.connect(code, { socket, role, clientId: ANA, hostToken: '' });
  return { session, sent, lyrics: () => sent.filter((m) => m.type === 'lyrics') };
}

async function roomPlaying() {
  const room = (await app.inject({ method: 'POST', url: '/api/rooms' })).json();
  const add = await app.inject({ method: 'POST', url: `/api/rooms/${room.code}/queue`, headers: { 'x-client-id': ANA }, payload: { video_id: SONG, name: 'Ana', artist: 'A', title: 'T' } });
  return { code: room.code, itemId: add.json().item_id };
}

const tvSends = (code, conn, message) => app.rooms.onMessage(code, conn.session.conn, JSON.stringify(message));

test('a letra mandada pela TV chega aos celulares (não à própria TV) e quem entra depois a recebe', async () => {
  const { code, itemId } = await roomPlaying();
  const phone = fakeConn(code, 'controller');
  const tv = fakeConn(code, 'tv');
  tvSends(code, tv, { type: 'lyrics', item_id: itemId, cues: CUES });
  assert.deepEqual(phone.lyrics(), [{ type: 'lyrics', item_id: itemId, cues: CUES }]);
  assert.deepEqual(tv.lyrics(), []);

  const late = fakeConn(code, 'controller'); // o palco abre depois de a música começar
  assert.deepEqual(late.lyrics(), [{ type: 'lyrics', item_id: itemId, cues: CUES }]);
  const anotherTv = fakeConn(code, 'tv');
  assert.deepEqual(anotherTv.lyrics(), []);
});

test('só a TV manda a letra, só da música que está tocando e só se estiver bem formada', async () => {
  const { code, itemId } = await roomPlaying();
  const phone = fakeConn(code, 'controller');
  const other = fakeConn(code, 'controller');
  tvSends(code, other, { type: 'lyrics', item_id: itemId, cues: CUES }); // um celular não tem esse poder
  const tv = fakeConn(code, 'tv');
  tvSends(code, tv, { type: 'lyrics', item_id: itemId + 99, cues: CUES }); // não é a música atual
  tvSends(code, tv, { type: 'lyrics', item_id: itemId, cues: [{ start: 'x', end: 2, text: 'a' }] });
  tvSends(code, tv, { type: 'lyrics', item_id: itemId, cues: 'lixo' });
  assert.deepEqual(phone.lyrics(), []);
  assert.deepEqual(fakeConn(code, 'controller').lyrics(), []); // nada ficou guardado
});

test('sanitizeCues limpa, limita e recusa o que não presta', () => {
  assert.deepEqual(sanitizeCues([{ start: 1, end: 2, text: 'oi', extra: 'x', words: [[1, 2]] }]), [{ start: 1, end: 2, text: 'oi', words: [[1, 2]] }]);
  assert.deepEqual(sanitizeCues([{ start: 1, end: 2, text: 'oi', words: [[1, 'a']] }]), [{ start: 1, end: 2, text: 'oi' }]); // palavras ruins: só a linha
  assert.equal(sanitizeCues(null), null);
  assert.equal(sanitizeCues(new Array(3001).fill({ start: 0, end: 1, text: 'a' })), null);
  assert.equal(sanitizeCues([{ start: 0, end: 1, text: 'a'.repeat(401) }]), null);
  assert.equal(sanitizeCues(new Array(2000).fill({ start: 0, end: 1, text: 'a'.repeat(300) })), null); // grande demais no total
  assert.deepEqual(sanitizeCues([]), []);
});
