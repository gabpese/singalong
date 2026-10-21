// The cloud: computers paired with an e-mail on the ENABLED_TO_SEND_TO_CLOUD list send their songs to the server,
// and any Room then plays them without downloading them from YouTube again.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { buildApp } from '../dist/app.js';
import { createMemoryJobStore } from '../dist/jobs.js';
import { LocalStorage } from '../dist/storage.js';

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
  app = await buildApp({
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

/** Pairs by e-mail (the real path): asks for the code, reads it in the "e-mail" and trades it for a token. */
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

test('a computer paired by e-mail stays tied to that e-mail; only those on the list send to the cloud', async () => {
  const owner = await pairByEmail('dono@exemplo.com');
  const friend = await pairByEmail('amigo@exemplo.com');
  const noEmail = await pairByAdmin();
  assert.equal((await call('GET', '/agent/v1/me', owner)).json().cloud, true);
  assert.equal((await call('GET', '/agent/v1/me', friend)).json().cloud, false); // may use the app, but does not send
  assert.equal((await call('GET', '/agent/v1/me', noEmail)).json().cloud, false); // the administrator's code, without an e-mail
  assert.equal((await put(friend, SONG, 'instrumental.mp3', MP3)).statusCode, 403);
  assert.equal((await put(noEmail, SONG, 'instrumental.mp3', MP3)).statusCode, 403);
  assert.equal((await call('POST', '/agent/v1/cloud/missing', { ...friend, payload: { ids: [SONG] } })).statusCode, 403);
  assert.equal((await call('PUT', `/agent/v1/cloud/${SONG}/instrumental.mp3`, { headers: { 'content-type': 'application/octet-stream' }, payload: MP3 })).statusCode, 401);

  // the administrator can also choose the code's e-mail
  const byAdmin = await pairByAdmin('Dono@Exemplo.com');
  assert.equal((await call('GET', '/agent/v1/me', byAdmin)).json().cloud, true);
});

test('a song counts as ready only when meta.json arrives, and it comes last', async () => {
  const owner = await pairByEmail('dono@exemplo.com');
  const id = 'ordemOrdem1';
  assert.equal((await put(owner, id, 'meta.json', meta(id))).statusCode, 409); // without the instrumental and the lyrics
  assert.equal((await put(owner, id, 'instrumental.mp3', MP3)).statusCode, 204);
  assert.equal((await put(owner, id, 'meta.json', meta(id))).statusCode, 409); // the lyrics are missing
  assert.deepEqual((await call('POST', '/agent/v1/cloud/missing', { ...owner, payload: { ids: [id] } })).json().missing, [id]);
  assert.equal((await put(owner, id, 'lyrics.json', LYRICS)).statusCode, 204);
  assert.equal((await put(owner, id, 'meta.json', meta(id))).statusCode, 204);
  assert.deepEqual((await call('POST', '/agent/v1/cloud/missing', { ...owner, payload: { ids: [id, 'outraOutra1'] } })).json().missing, ['outraOutra1']);
});

test('only the allowed, valid files go in (the isolated voice, what is not an MP3 and broken JSON stay out)', async () => {
  const owner = await pairByEmail('dono@exemplo.com');
  const id = 'validaValid';
  assert.equal((await put(owner, id, 'vocals.mp3', MP3)).statusCode, 400); // not on the list
  assert.equal((await put(owner, id, 'source.json', Buffer.from('{}'))).statusCode, 400);
  assert.equal((await put(owner, id, 'instrumental.mp3', Buffer.from('isto é um texto'))).statusCode, 400);
  assert.equal((await put(owner, id, 'instrumental.mp3', Buffer.alloc(0))).statusCode, 400);
  assert.equal((await put(owner, id, 'lyrics.json', Buffer.from('{quebrado'))).statusCode, 400);
  const big = await put(owner, id, 'lyrics.json', Buffer.alloc(11 * 1024 * 1024, 32));
  assert.equal(big.statusCode, 413, big.body);
  assert.ok([400, 404].includes((await put(owner, '../../etc', 'instrumental.mp3', MP3)).statusCode)); // an invalid id: it never gets to write
  assert.equal((await put(owner, 'curto', 'instrumental.mp3', MP3)).statusCode, 400);
  await put(owner, id, 'instrumental.mp3', MP3);
  await put(owner, id, 'lyrics.json', LYRICS);
  assert.equal((await put(owner, id, 'meta.json', meta('outroIdAqui'))).statusCode, 400); // the meta must be this song's
  assert.equal((await put(owner, id, 'meta.json', Buffer.from('[]'))).statusCode, 400);
});

test('a plain Room (without the app) plays the song in the cloud at once, without creating a job', async () => {
  const owner = await pairByEmail('dono@exemplo.com');
  await uploadSong(owner);
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
  assert.ok(item.song.media.melody); // the optional file that was sent is there too
  assert.equal(item.song.media.backing, null);
  const file = await call('GET', `/media/cache/${SONG}/instrumental.mp3`);
  assert.equal(file.statusCode, 200);
  assert.equal(file.rawPayload.length, MP3.length);
  assert.equal(await jobs.get(SONG), null); // no download was asked for
  const library = (await call('GET', '/api/songs')).json();
  assert.ok(library.some((m) => m.video_id === SONG)); // and it shows in the Jukebox
});

test("ANOTHER person's computer, with local storage, also uses the song from the cloud", async () => {
  const owner = await pairByEmail('dono@exemplo.com');
  await uploadSong(owner, 'nuvemNuvem1');
  const friend = await pairByEmail('amigo@exemplo.com');
  const session = (await call('POST', '/agent/v1/sessions', { ...friend, payload: { display_name: 'Bia', media_base: 'http://127.0.0.1:8765/token123' } })).json();
  const room = (await call('POST', `/agent/v1/sessions/${session.id}/rooms`, { ...friend, payload: {} })).json();
  const add = await call('POST', `/api/rooms/${room.code}/queue`, { headers: { 'x-client-id': 'cliente-bbbbbbbb' }, payload: { video_id: 'nuvemNuvem1', artist: 'A', title: 'T', name: 'Caio' } });
  assert.equal(add.statusCode, 201);
  const state = (await call('GET', `/api/rooms/${room.code}`, { headers: { 'x-client-id': 'cliente-bbbbbbbb' } })).json();
  const item = state.queue.find((i) => i.video_id === 'nuvemNuvem1');
  assert.equal(item.song.ready, true);
  assert.equal(item.song.media.local, false); // it comes from the cloud, not from their computer
  const claim = await call('POST', '/agent/v1/jobs/claim', { headers: friend.headers, payload: { wait_ms: 0 } });
  assert.equal(claim.statusCode, 204); // nothing to download
});

test('sending the same file again replaces it (corrected lyrics reach the cloud)', async () => {
  const owner = await pairByEmail('dono@exemplo.com');
  await uploadSong(owner, 'trocaTroca1');
  assert.equal((await put(owner, 'trocaTroca1', 'lyrics.json', Buffer.from('[{"t":1}]'))).statusCode, 204);
  assert.equal((await call('GET', '/media/cache/trocaTroca1/lyrics.json')).body, '[{"t":1}]');
});
