// Nuvem: os computadores pareados com um e-mail da lista ENABLED_TO_SEND_TO_CLOUD enviam as músicas para o servidor,
// e qualquer sala passa a tocá-las sem baixar de novo do YouTube.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { buildApp } from '../src/app.js';
import { createMemoryJobStore } from '../src/jobs.js';
import { LocalStorage } from '../src/storage.js';

const LOOSE = { max: 1e6, windowMs: 60_000 };
const SONG = 'abcdefghijk';
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(200, 1)]);
const meta = (id = SONG) => Buffer.from(JSON.stringify({ video_id: id, title: 'Tempo Perdido', artist: 'Legião Urbana', duration: 30 }));
const LYRICS = Buffer.from('[]');
const sent = [];
let app;
let jobs;
let root;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'singalong-cloud-'));
  jobs = createMemoryJobStore();
  app = buildApp({
    config: {
      publicDir: root,
      adminToken: 'adm',
      pairAllowedEmails: ['dono@exemplo.com', 'amigo@exemplo.com'],
      cloudUploadEmails: ['dono@exemplo.com'],
      rateLimits: { pair: LOOSE, pairRequest: LOOSE, pairEmail: LOOSE, createRoom: LOOSE, addToQueue: LOOSE, search: LOOSE },
    },
    storage: new LocalStorage(root),
    jobs,
    mailer: { enabled: true, send: async (message) => { sent.push(message); } },
  });
  await app.ready();
});

after(() => app.close());

const call = (method, url, { headers = {}, payload } = {}) => app.inject({ method, url, headers, payload });

/** Pareia pelo e-mail (o caminho de verdade): pede o código, lê no "e-mail" e troca por um token. */
async function pairByEmail(email) {
  sent.length = 0;
  assert.equal((await call('POST', '/agent/v1/pair/request', { payload: { email } })).statusCode, 202);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const code = /código[^:]*: ([A-Z0-9]{8})/.exec(sent.at(-1).text)[1];
  const done = await call('POST', '/agent/v1/pair/complete', { payload: { code, name: `PC de ${email}` } });
  assert.equal(done.statusCode, 201);
  return { headers: { authorization: `Bearer ${done.json().token}` } };
}

async function pairByAdmin(email) {
  const start = await call('POST', '/agent/v1/pair/start', { headers: { 'x-admin-token': 'adm' }, payload: email ? { email } : {} });
  const done = await call('POST', '/agent/v1/pair/complete', { payload: { code: start.json().code, name: 'PC' } });
  return { headers: { authorization: `Bearer ${done.json().token}` } };
}

const put = (agent, id, file, body) =>
  call('PUT', `/agent/v1/cloud/${id}/${file}`, { headers: { ...agent.headers, 'content-type': 'application/octet-stream' }, payload: body });

async function uploadSong(agent, id = SONG) {
  assert.equal((await put(agent, id, 'instrumental.mp3', MP3)).statusCode, 204);
  assert.equal((await put(agent, id, 'lyrics.json', LYRICS)).statusCode, 204);
  assert.equal((await put(agent, id, 'melody.json', Buffer.from('{"hop":0.05,"midi":[60]}'))).statusCode, 204);
  assert.equal((await put(agent, id, 'meta.json', meta(id))).statusCode, 204);
}

test('o computador pareado por e-mail fica ligado a esse e-mail; só quem está na lista envia para a nuvem', async () => {
  const dono = await pairByEmail('dono@exemplo.com');
  const amigo = await pairByEmail('amigo@exemplo.com');
  const semEmail = await pairByAdmin();
  assert.equal((await call('GET', '/agent/v1/me', dono)).json().cloud, true);
  assert.equal((await call('GET', '/agent/v1/me', amigo)).json().cloud, false); // pode usar o app, mas não envia
  assert.equal((await call('GET', '/agent/v1/me', semEmail)).json().cloud, false); // código do administrador sem e-mail
  assert.equal((await put(amigo, SONG, 'instrumental.mp3', MP3)).statusCode, 403);
  assert.equal((await put(semEmail, SONG, 'instrumental.mp3', MP3)).statusCode, 403);
  assert.equal((await call('POST', '/agent/v1/cloud/missing', { ...amigo, payload: { ids: [SONG] } })).statusCode, 403);
  assert.equal((await call('PUT', `/agent/v1/cloud/${SONG}/instrumental.mp3`, { headers: { 'content-type': 'application/octet-stream' }, payload: MP3 })).statusCode, 401);

  // o administrador também pode escolher o e-mail do código
  const porAdmin = await pairByAdmin('Dono@Exemplo.com');
  assert.equal((await call('GET', '/agent/v1/me', porAdmin)).json().cloud, true);
});

test('a música só conta como pronta quando o meta.json chega, e ele é o último', async () => {
  const dono = await pairByEmail('dono@exemplo.com');
  const id = 'ordemOrdem1';
  assert.equal((await put(dono, id, 'meta.json', meta(id))).statusCode, 409); // sem instrumental e letra
  assert.equal((await put(dono, id, 'instrumental.mp3', MP3)).statusCode, 204);
  assert.equal((await put(dono, id, 'meta.json', meta(id))).statusCode, 409); // falta a letra
  assert.deepEqual((await call('POST', '/agent/v1/cloud/missing', { ...dono, payload: { ids: [id] } })).json().missing, [id]);
  assert.equal((await put(dono, id, 'lyrics.json', LYRICS)).statusCode, 204);
  assert.equal((await put(dono, id, 'meta.json', meta(id))).statusCode, 204);
  assert.deepEqual((await call('POST', '/agent/v1/cloud/missing', { ...dono, payload: { ids: [id, 'outraOutra1'] } })).json().missing, ['outraOutra1']);
});

test('só os arquivos permitidos e válidos entram (a voz isolada, o que não é MP3 e o JSON quebrado ficam de fora)', async () => {
  const dono = await pairByEmail('dono@exemplo.com');
  const id = 'validaValid';
  assert.equal((await put(dono, id, 'vocals.mp3', MP3)).statusCode, 400); // fora da lista
  assert.equal((await put(dono, id, 'source.json', Buffer.from('{}'))).statusCode, 400);
  assert.equal((await put(dono, id, 'instrumental.mp3', Buffer.from('isto é um texto'))).statusCode, 400);
  assert.equal((await put(dono, id, 'instrumental.mp3', Buffer.alloc(0))).statusCode, 400);
  assert.equal((await put(dono, id, 'lyrics.json', Buffer.from('{quebrado'))).statusCode, 400);
  const big = await put(dono, id, 'lyrics.json', Buffer.alloc(11 * 1024 * 1024, 32));
  assert.equal(big.statusCode, 413, big.body);
  assert.ok([400, 404].includes((await put(dono, '../../etc', 'instrumental.mp3', MP3)).statusCode)); // id inválido: nunca chega a gravar
  assert.equal((await put(dono, 'curto', 'instrumental.mp3', MP3)).statusCode, 400);
  await put(dono, id, 'instrumental.mp3', MP3);
  await put(dono, id, 'lyrics.json', LYRICS);
  assert.equal((await put(dono, id, 'meta.json', meta('outroIdAqui'))).statusCode, 400); // o meta tem de ser desta música
  assert.equal((await put(dono, id, 'meta.json', Buffer.from('[]'))).statusCode, 400);
});

test('uma sala comum (sem app) toca na hora a música que está na nuvem, sem criar job', async () => {
  const dono = await pairByEmail('dono@exemplo.com');
  await uploadSong(dono);
  const room = (await call('POST', '/api/rooms')).json();
  const state = await call('GET', `/api/rooms/${room.code}`);
  assert.equal(state.statusCode, 200);
  const add = await call('POST', `/api/rooms/${room.code}/queue`, { headers: { 'x-client-id': 'cliente-aaaaaaaa' }, payload: { video_id: SONG, artist: 'Legião Urbana', title: 'Tempo Perdido', name: 'Ana' } });
  assert.equal(add.statusCode, 201);
  const after = (await call('GET', `/api/rooms/${room.code}`, { headers: { 'x-client-id': 'cliente-aaaaaaaa' } })).json();
  const item = after.queue.find((i) => i.video_id === SONG);
  assert.equal(item.song.ready, true);
  assert.equal(item.song.media.local, false);
  assert.match(item.song.media.instrumental, new RegExp(`/media/cache/${SONG}/instrumental.mp3$`));
  assert.ok(item.song.media.melody); // o opcional que foi enviado também está lá
  assert.equal(item.song.media.backing, null);
  const file = await call('GET', `/media/cache/${SONG}/instrumental.mp3`);
  assert.equal(file.statusCode, 200);
  assert.equal(file.rawPayload.length, MP3.length);
  assert.equal(await jobs.get(SONG), null); // nenhum download foi pedido
  const library = (await call('GET', '/api/songs')).json();
  assert.ok(library.some((m) => m.video_id === SONG)); // e aparece na biblioteca
});

test('o computador de OUTRA pessoa, com armazenamento local, também usa a música da nuvem', async () => {
  const dono = await pairByEmail('dono@exemplo.com');
  await uploadSong(dono, 'nuvemNuvem1');
  const amigo = await pairByEmail('amigo@exemplo.com');
  const session = (await call('POST', '/agent/v1/sessions', { ...amigo, payload: { display_name: 'Bia', media_base: 'http://127.0.0.1:8765/token123' } })).json();
  const room = (await call('POST', `/agent/v1/sessions/${session.id}/rooms`, { ...amigo, payload: {} })).json();
  const add = await call('POST', `/api/rooms/${room.code}/queue`, { headers: { 'x-client-id': 'cliente-bbbbbbbb' }, payload: { video_id: 'nuvemNuvem1', artist: 'A', title: 'T', name: 'Caio' } });
  assert.equal(add.statusCode, 201);
  const state = (await call('GET', `/api/rooms/${room.code}`, { headers: { 'x-client-id': 'cliente-bbbbbbbb' } })).json();
  const item = state.queue.find((i) => i.video_id === 'nuvemNuvem1');
  assert.equal(item.song.ready, true);
  assert.equal(item.song.media.local, false); // vem da nuvem, não do computador dela
  const claim = await call('POST', '/agent/v1/jobs/claim', { headers: amigo.headers, payload: { wait_ms: 0 } });
  assert.equal(claim.statusCode, 204); // nada para baixar
});

test('mandar de novo o mesmo arquivo substitui (uma letra corrigida chega à nuvem)', async () => {
  const dono = await pairByEmail('dono@exemplo.com');
  await uploadSong(dono, 'trocaTroca1');
  assert.equal((await put(dono, 'trocaTroca1', 'lyrics.json', Buffer.from('[{"t":1}]'))).statusCode, 204);
  assert.equal((await call('GET', '/media/cache/trocaTroca1/lyrics.json')).body, '[{"t":1}]');
});
