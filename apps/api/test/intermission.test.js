// Intervalo entre músicas: os aplausos depois de uma música e a subida ao palco antes da próxima (com durações curtas aqui).
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { buildApp } from '../src/app.js';
import { createMemoryJobStore } from '../src/jobs.js';
import { LocalStorage } from '../src/storage.js';

const NO_LIMITS = { search: { max: 1e6, windowMs: 60_000 }, addToQueue: { max: 1e6, windowMs: 60_000 }, createRoom: { max: 1e6, windowMs: 60_000 } };
const READY_A = 'readySongA1';
const READY_B = 'readySongB1';
const ANA = 'client-ana-0001';
const BIA = 'client-bia-0001';
const APPLAUSE_MS = 400;
const STAGE_MS = 400;

let root;
let app;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function seed(id) {
  const dir = join(root, 'cache', id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'instrumental.mp3'), '0123456789');
  await writeFile(join(dir, 'lyrics.json'), '[]');
  await writeFile(join(dir, 'meta.json'), JSON.stringify({ video_id: id, title: `Título ${id}`, artist: 'Artista', duration: 200 }));
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'singalong-intermission-'));
  const publicDir = join(root, 'public');
  await mkdir(publicDir);
  await writeFile(join(publicDir, 'index.html'), 'ok');
  for (const id of [READY_A, READY_B]) await seed(id);
  app = buildApp({
    config: { publicDir, rateLimits: NO_LIMITS, intermissionApplauseMs: APPLAUSE_MS, intermissionStageMs: STAGE_MS },
    storage: new LocalStorage(root),
    jobs: createMemoryJobStore(),
  });
  await app.ready();
});

after(() => app.close());

async function call(method, url, { client = ANA, host, body } = {}) {
  const headers = { 'x-client-id': client };
  if (host) headers['x-host-token'] = host;
  const res = await app.inject({ method, url: `/api${url}`, headers, payload: body });
  return { status: res.statusCode, body: res.body ? res.json() : null };
}

/** Uma sala com a TV conectada (sem TV não há intervalo: nada tocaria). */
async function roomWithTv() {
  const { body } = await call('POST', '/rooms');
  const socket = { readyState: 1, send() {}, ping() {}, terminate() {} };
  app.rooms.connect(body.code, { socket, role: 'tv', clientId: '' });
  return { code: body.code, host: body.host_token };
}

const add = (code, videoId, client = ANA, name = 'Ana') =>
  call('POST', `/rooms/${code}/queue`, { client, body: { video_id: videoId, name, artist: 'Artista', title: 'Título' } });
const state = async (code) => (await call('GET', `/rooms/${code}`)).body;

test('a sala nasce com o intervalo ligado; a primeira música entra em "intro" (subida ao palco) e depois toca', async () => {
  const { code } = await roomWithTv();
  const a = (await add(code, READY_A)).body.item_id;
  let s = await state(code);
  assert.equal(s.intermission, true);
  assert.equal(s.current_item_id, a);
  assert.equal(s.playback, 'intro');
  assert.equal(s.interlude.phase, 'stage');
  assert.equal(s.interlude.item_id, a);
  assert.equal(s.interlude.singers, 'Ana');
  assert.equal(s.interlude.total_ms, STAGE_MS);
  assert.ok(s.interlude.left_ms > 0 && s.interlude.left_ms <= STAGE_MS);
  await sleep(STAGE_MS + 150);
  s = await state(code);
  assert.equal(s.playback, 'playing');
  assert.equal(s.interlude, null);
});

test('fim da música: aplausos (com a nota, se houve pontuação), a fila espera, e só depois o próximo sobe ao palco', async () => {
  const { code, host } = await roomWithTv();
  await call('PATCH', `/rooms/${code}`, { host, body: { scoring: true } });
  const a = (await add(code, READY_A)).body.item_id;
  const b = (await add(code, READY_B, BIA, 'Bia')).body.item_id;
  await call('POST', `/rooms/${code}/player/start`, { host }); // pula a subida da primeira
  app.rooms.tvScore(code, a, 87);
  await app.rooms.tvEnded(code, a);
  let s = await state(code);
  assert.equal(s.current_item_id, null); // durante os aplausos ninguém está na vez
  assert.equal(s.interlude.phase, 'applause');
  assert.equal(s.interlude.item_id, a);
  assert.equal(s.interlude.singers, 'Ana');
  assert.equal(s.interlude.score, 87);
  assert.equal(s.next_item_id, b); // quem vem depois já aparece
  await sleep(APPLAUSE_MS + 150);
  s = await state(code);
  assert.equal(s.current_item_id, b);
  assert.equal(s.playback, 'intro');
  assert.equal(s.interlude.phase, 'stage');
  assert.equal(s.interlude.singers, 'Bia');
});

test('pular a música (anfitrião) não tem aplausos: a próxima sobe ao palco direto', async () => {
  const { code, host } = await roomWithTv();
  await add(code, READY_A);
  const b = (await add(code, READY_B, BIA, 'Bia')).body.item_id;
  await call('POST', `/rooms/${code}/player/start`, { host });
  await call('POST', `/rooms/${code}/player/skip`, { host });
  const s = await state(code);
  assert.equal(s.current_item_id, b);
  assert.equal(s.interlude.phase, 'stage');
});

test('"começar agora" é do anfitrião: nos aplausos pula o intervalo inteiro, na subida ao palco começa a música', async () => {
  const { code, host } = await roomWithTv();
  const a = (await add(code, READY_A)).body.item_id;
  const b = (await add(code, READY_B, BIA, 'Bia')).body.item_id;
  assert.equal((await call('POST', `/rooms/${code}/player/start`, { client: BIA })).status, 403);
  assert.equal((await call('POST', `/rooms/${code}/player/start`, { host })).body.playback, 'playing');
  await app.rooms.tvEnded(code, a);
  assert.equal((await state(code)).interlude.phase, 'applause');
  const s = (await call('POST', `/rooms/${code}/player/start`, { host })).body;
  assert.equal(s.current_item_id, b);
  assert.equal(s.playback, 'playing'); // sem a subida ao palco
  assert.equal(s.interlude, null);
});

test('com o intervalo desligado a próxima música toca na hora; desligar no meio do intervalo começa a música', async () => {
  const { code, host } = await roomWithTv();
  const a = (await add(code, READY_A)).body.item_id;
  assert.equal((await state(code)).playback, 'intro');
  const off = (await call('PATCH', `/rooms/${code}`, { host, body: { intermission: false } })).body;
  assert.equal(off.intermission, false);
  assert.equal(off.playback, 'playing');
  const b = (await add(code, READY_B, BIA, 'Bia')).body.item_id;
  await app.rooms.tvEnded(code, a);
  const s = await state(code);
  assert.equal(s.current_item_id, b);
  assert.equal(s.playback, 'playing');
  assert.equal(s.interlude, null);
  assert.equal((await call('PATCH', `/rooms/${code}`, { client: BIA, body: { intermission: true } })).status, 403); // só o anfitrião
});

test('sem TV conectada não há intervalo (nada tocaria: esperar não ajuda ninguém)', async () => {
  const { body } = await call('POST', '/rooms');
  await add(body.code, READY_A);
  const s = await state(body.code);
  assert.equal(s.playback, 'playing');
  assert.equal(s.interlude, null);
});

test('pausar na subida ao palco segura a música; retomar começa', async () => {
  const { code, host } = await roomWithTv();
  await add(code, READY_A);
  assert.equal((await call('POST', `/rooms/${code}/player/pause`, { host })).body.playback, 'paused');
  await sleep(STAGE_MS + 150);
  assert.equal((await state(code)).playback, 'paused'); // o fim da subida não passa por cima da pausa
  assert.equal((await call('POST', `/rooms/${code}/player/resume`, { host })).body.playback, 'playing');
});
