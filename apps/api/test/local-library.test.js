// Armazenamento local: as músicas estão no computador do dono; a nuvem só conhece o catálogo que o agente publica e o endereço
// do servidor local de mídia (media_base), de onde o navegador as busca.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { normalizeMediaBase } from '../src/agents.js';
import { buildApp } from '../src/app.js';
import { createMemoryJobStore } from '../src/jobs.js';
import { LocalStorage } from '../src/storage.js';

const BIG = { max: 1e6, windowMs: 60_000 };
const ADMIN = { 'x-admin-token': 'segredo-do-admin' };
const CLIENT = { 'x-client-id': 'cliente-aaaaaaaa' };
const BASE = 'http://127.0.0.1:8765/tok123';
const SONG = 'abcdefghijk';
const IMPORTED = 'f-0123456789ab';

let app;
let root;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'singalong-local-'));
  app = buildApp({
    config: { publicDir: root, adminToken: 'segredo-do-admin', rateLimits: { search: BIG, addToQueue: BIG, createRoom: BIG, pair: BIG } },
    storage: new LocalStorage(root),
    jobs: createMemoryJobStore(),
  });
  await app.ready();
});

after(() => app.close());

const call = (method, url, { headers = {}, payload } = {}) => app.inject({ method, url, headers, payload });

async function pair(name = 'PC') {
  const { code } = (await call('POST', '/agent/v1/pair/start', { headers: ADMIN, payload: {} })).json();
  const { token, device_id: id } = (await call('POST', '/agent/v1/pair/complete', { payload: { code, name } })).json();
  return { id, headers: { authorization: `Bearer ${token}` } };
}

async function session(agent, mediaBase = BASE, name = 'Dona Flor') {
  const res = await call('POST', '/agent/v1/sessions', { headers: agent.headers, payload: { display_name: name, ...(mediaBase ? { media_base: mediaBase } : {}) } });
  assert.equal(res.statusCode, 201, res.body);
  return res.json();
}

async function room(agent, sess) {
  return (await call('POST', `/agent/v1/sessions/${sess.id}/rooms`, { headers: agent.headers, payload: {} })).json();
}

const entry = (id = SONG, over = {}) => ({
  id,
  meta: { video_id: id, title: 'Tempo Perdido', artist: 'Legião Urbana', duration: 300, lyrics_source: 'lrclib', key: { tonic: 3, mode: 'major' }, ...(over.meta ?? {}) },
  files: { instrumental: true, lyrics: true, melody: false, backing: false, exports: [], ...(over.files ?? {}) },
});

const publish = (agent, songs) => call('PUT', '/agent/v1/library', { headers: agent.headers, payload: { songs } });
const claim = (agent) => call('POST', '/agent/v1/jobs/claim', { headers: agent.headers, payload: { wait_ms: 0 } });
const state = async (r) => (await call('GET', `/api/rooms/${r.code}`, { headers: CLIENT })).json();
const addSong = (r, id = SONG, payload = {}) => call('POST', `/api/rooms/${r.code}/queue`, { headers: CLIENT, payload: { video_id: id, ...payload } });

test('normalizeMediaBase: só máquina local ou rede privada, só http, sem credenciais, consulta nem caminho aninhado', () => {
  for (const ok of ['http://127.0.0.1:8765', 'http://127.0.0.1:8765/', 'http://127.0.0.1:8765/tok_123-A', 'http://localhost:9000/x', 'http://192.168.0.4:8765/t', 'http://10.1.2.3/t', 'http://172.20.0.9:80/t', 'http://[::1]:8765/t']) {
    assert.ok(normalizeMediaBase(ok), ok);
  }
  assert.equal(normalizeMediaBase('http://127.0.0.1:8765/tok/'), 'http://127.0.0.1:8765/tok');
  assert.equal(normalizeMediaBase(undefined), null);
  assert.equal(normalizeMediaBase(''), null);
  for (const bad of ['http://evil.example.com/t', 'https://127.0.0.1:8765/t', 'http://user:pw@127.0.0.1/t', 'http://127.0.0.1/t?x=1', 'http://127.0.0.1/t#h', 'http://127.0.0.1/a/b', 'javascript:alert(1)', 'http://10.0.0.1.evil.com/t', 'http://172.32.0.1/t', 'http://8.8.8.8/t', 'nao-e-url']) {
    assert.throws(() => normalizeMediaBase(bad), { code: 'invalid_media_base' }, bad);
  }
});

test('o servidor recusa um endereço de mídia inválido ao iniciar a sessão e na batida de coração', async () => {
  const agent = await pair();
  const bad = await call('POST', '/agent/v1/sessions', { headers: agent.headers, payload: { display_name: 'X', media_base: 'http://evil.example.com/t' } });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error, 'invalid_media_base');
  assert.equal((await call('GET', '/agent/v1/me', { headers: agent.headers })).json().session, null); // nada foi criado

  await session(agent);
  const beat = await call('POST', '/agent/v1/heartbeat', { headers: agent.headers, payload: { media_base: 'http://evil.example.com/t' } });
  assert.equal(beat.statusCode, 400);
});

test('a música do catálogo do dono aparece pronta na sala, com os endereços do servidor local de mídia', async () => {
  const agent = await pair();
  const sess = await session(agent);
  const r = await room(agent, sess);
  assert.equal((await publish(agent, [entry(SONG, { files: { melody: true } })])).statusCode, 200);

  // a nuvem NÃO tem os arquivos (nada no armazenamento do servidor): só o catálogo
  assert.equal((await addSong(r, SONG)).statusCode, 201); // pronta: dispensa artista e nome
  const item = (await state(r)).queue[0];
  assert.equal(item.song.ready, true);
  assert.equal(item.song.status, 'ready');
  assert.deepEqual([item.title, item.artist, item.song.duration, item.song.lyrics_source], ['Tempo Perdido', 'Legião Urbana', 300, 'lrclib']);
  assert.deepEqual(item.song.media, {
    instrumental: `${BASE}/cache/${SONG}/instrumental.mp3`,
    lyrics: `${BASE}/cache/${SONG}/lyrics.json`,
    melody: `${BASE}/cache/${SONG}/melody.json`,
    backing: null,
    local: true,
  });
  assert.equal((await state(r)).current_item_id !== null, true); // e já toca
});

test('só o instrumental e a letra publicados contam como pronta; vozes de apoio publicadas depois entram na sala', async () => {
  const agent = await pair();
  const sess = await session(agent);
  const r = await room(agent, sess);
  await publish(agent, [entry(SONG, { files: { instrumental: true, lyrics: false } })]);
  assert.equal((await addSong(r, SONG)).statusCode, 400); // não está pronta e faltam artista e nome
  await publish(agent, [entry(SONG)]);
  assert.equal((await addSong(r, SONG)).statusCode, 201);
  assert.equal((await state(r)).queue[0].song.media.backing, null);

  await publish(agent, [entry(SONG, { files: { backing: true } })]); // a análise das vozes de apoio terminou
  assert.equal((await state(r)).queue[0].song.media.backing, `${BASE}/cache/${SONG}/backing.mp3`);
});

test('a biblioteca da sala é o catálogo do dono; sem a sala, é a do servidor', async () => {
  const agent = await pair();
  const sess = await session(agent);
  const r = await room(agent, sess);
  await publish(agent, [entry('aaaaaaaaaaa'), entry('bbbbbbbbbbb', { meta: { title: 'Outra' } })]);

  const mine = (await call('GET', '/api/songs', { headers: { 'x-room': r.code } })).json();
  assert.deepEqual(mine.map((m) => m.video_id).sort(), ['aaaaaaaaaaa', 'bbbbbbbbbbb']);
  assert.deepEqual((await call('GET', '/api/songs')).json(), []); // a do servidor está vazia
  const one = (await call('GET', '/api/songs/aaaaaaaaaaa', { headers: { 'x-room': r.code } })).json();
  assert.equal(one.status, 'ready');
  assert.equal((await call('GET', '/api/songs/aaaaaaaaaaa')).statusCode, 404); // sem a sala, o servidor não a conhece
});

test('o catálogo é de cada dono: outra sessão não vê as músicas dele', async () => {
  const a = await pair('A');
  const b = await pair('B');
  const ra = await room(a, await session(a, 'http://127.0.0.1:8001/ta', 'Ana'));
  const rb = await room(b, await session(b, 'http://127.0.0.1:8002/tb', 'Beto'));
  await publish(a, [entry(SONG)]);

  assert.equal((await call('GET', '/api/songs', { headers: { 'x-room': rb.code } })).json().length, 0);
  assert.equal((await addSong(rb, SONG)).statusCode, 400); // para o Beto não está pronta (e faltam artista e nome)
  assert.equal((await addSong(ra, SONG)).statusCode, 201);
  assert.equal((await state(ra)).queue[0].song.media.instrumental, `http://127.0.0.1:8001/ta/cache/${SONG}/instrumental.mp3`);
});

test('uma sessão sem servidor local de mídia continua usando o armazenamento do servidor', async () => {
  const agent = await pair();
  const r = await room(agent, await session(agent, null));
  await publish(agent, [entry(SONG)]); // o catálogo existe, mas sem media_base a sala não o usa
  assert.equal((await call('GET', '/api/songs', { headers: { 'x-room': r.code } })).json().length, 0);
  assert.equal((await addSong(r, SONG)).statusCode, 400);
});

test('a batida de coração ou retomar a sessão troca o endereço de mídia (o agente reiniciou o servidor local)', async () => {
  const agent = await pair();
  const sess = await session(agent);
  const r = await room(agent, sess);
  await publish(agent, [entry(SONG)]);
  await addSong(r, SONG);
  assert.match((await state(r)).queue[0].song.media.instrumental, /127\.0\.0\.1:8765\/tok123\//);

  await call('POST', '/agent/v1/heartbeat', { headers: agent.headers, payload: { media_base: 'http://127.0.0.1:9999/novo' } });
  assert.match((await state(r)).queue[0].song.media.instrumental, /127\.0\.0\.1:9999\/novo\//);

  const resumed = await call('POST', '/agent/v1/sessions', { headers: agent.headers, payload: { display_name: 'Dona Flor', resume_id: sess.id, media_base: 'http://127.0.0.1:7777/outro' } });
  assert.equal(resumed.json().id, sess.id);
  assert.match((await state(r)).queue[0].song.media.instrumental, /127\.0\.0\.1:7777\/outro\//);
});

test('tirar do catálogo: a música deixa de estar pronta; tirar de novo é 404', async () => {
  const agent = await pair();
  const r = await room(agent, await session(agent));
  await publish(agent, [entry(SONG)]);
  assert.equal((await call('DELETE', `/agent/v1/library/${SONG}`, { headers: agent.headers })).statusCode, 204);
  assert.equal((await call('DELETE', `/agent/v1/library/${SONG}`, { headers: agent.headers })).statusCode, 404);
  assert.equal((await call('GET', '/api/songs', { headers: { 'x-room': r.code } })).json().length, 0);
});

test('validação do catálogo: identificador, meta, lote e autenticação', async () => {
  const agent = await pair();
  await session(agent);
  assert.equal((await publish(agent, [{ ...entry(), id: 'curto' }])).statusCode, 400);
  assert.equal((await publish(agent, [{ ...entry(), id: 'f-xyz' }])).statusCode, 400);
  assert.equal((await publish(agent, [{ ...entry(), meta: 'texto' }])).statusCode, 400);
  assert.equal((await publish(agent, [{ ...entry(), meta: { grande: 'x'.repeat(25_000) } }])).statusCode, 400);
  assert.equal((await publish(agent, Array.from({ length: 101 }, (_, i) => entry(`m${String(i).padStart(10, '0')}`)))).statusCode, 400);
  assert.equal((await publish(agent, [entry()])).statusCode, 200);
  assert.equal((await call('PUT', '/agent/v1/library', { payload: { songs: [] } })).statusCode, 401);
  // um tom de MP4 fora de −6..+6 é descartado
  await publish(agent, [entry('ccccccccccc', { files: { exports: [2, 99, -3, 'x'] } })]);
  const room1 = await room(agent, await session(agent));
  await addSong(room1, 'ccccccccccc');
  assert.equal((await call('GET', '/api/songs/ccccccccccc/export?pitch=2', { headers: { 'x-room': room1.code } })).json().status, 'ready');
  assert.equal((await call('GET', '/api/songs/ccccccccccc/export?pitch=99', { headers: { 'x-room': room1.code } })).statusCode, 400);
});

test('MP4 exportado no computador do dono: o catálogo diz quais tons existem e a URL aponta para o servidor local', async () => {
  const agent = await pair();
  const r = await room(agent, await session(agent));
  await publish(agent, [entry(SONG)]);
  const headers = { 'x-room': r.code };

  const none = (await call('GET', `/api/songs/${SONG}/export?pitch=2`, { headers })).json();
  assert.deepEqual([none.status, none.url], ['none', null]);
  const asked = await call('POST', `/api/songs/${SONG}/export`, { headers, payload: { pitch: 2 } });
  assert.equal(asked.statusCode, 202); // vai para o agente da sessão
  const claimed = await call('POST', '/agent/v1/exports/claim', { headers: agent.headers, payload: { wait_ms: 0 } });
  assert.deepEqual(claimed.json().request, { video_id: SONG, pitch: 2 });

  await publish(agent, [entry(SONG, { files: { exports: [2] } })]); // o agente gerou o MP4 e atualizou o catálogo
  const ready = (await call('GET', `/api/songs/${SONG}/export?pitch=2`, { headers })).json();
  assert.deepEqual([ready.status, ready.url, ready.local], ['ready', `${BASE}/cache/${SONG}/karaoke_p+2.mp4`, true]);
  await publish(agent, [entry(SONG, { files: { exports: [0, -3] } })]);
  assert.equal((await call('GET', `/api/songs/${SONG}/export?pitch=0`, { headers })).json().url, `${BASE}/cache/${SONG}/karaoke.mp4`);
  assert.equal((await call('GET', `/api/songs/${SONG}/export?pitch=-3`, { headers })).json().url, `${BASE}/cache/${SONG}/karaoke_p-3.mp4`);
});

test('músicas importadas (f-<hash>) entram no catálogo, na fila e na rota de músicas', async () => {
  const agent = await pair();
  const r = await room(agent, await session(agent));
  assert.equal((await publish(agent, [entry(IMPORTED, { meta: { title: 'Meu arquivo' } })])).statusCode, 200);
  assert.equal((await addSong(r, IMPORTED)).statusCode, 201);
  assert.equal((await state(r)).queue[0].song.media.instrumental, `${BASE}/cache/${IMPORTED}/instrumental.mp3`);
  assert.equal((await call('GET', `/api/songs/${IMPORTED}`, { headers: { 'x-room': r.code } })).json().status, 'ready');
  assert.equal((await addSong(r, 'f-zzzzzzzzzzzz')).statusCode, 400); // formato inválido
});

test('o dono sair da sessão não apaga o catálogo dele (a biblioteca é do dispositivo, não da sessão)', async () => {
  const agent = await pair();
  const s1 = await session(agent);
  await publish(agent, [entry(SONG)]);
  await call('DELETE', `/agent/v1/sessions/${s1.id}`, { headers: agent.headers });
  const r2 = await room(agent, await session(agent));
  assert.equal((await call('GET', '/api/songs', { headers: { 'x-room': r2.code } })).json().length, 1);
});

test('música importada que não está no catálogo do dono não vira job do YouTube', async () => {
  const agent = await pair();
  const r = await room(agent, await session(agent));
  const res = await addSong(r, IMPORTED, { artist: 'A', title: 'B' }); // mesmo com artista e nome: não há o que baixar
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'song_not_found');
  assert.equal((await claim(agent)).statusCode, 204); // nenhum job foi enfileirado para o agente
  assert.equal((await state(r)).queue.length, 0);
});

test('a letra de uma música importada não se troca por job (importa-se o arquivo de novo)', async () => {
  const agent = await pair();
  const r = await room(agent, await session(agent));
  await publish(agent, [entry(IMPORTED, { meta: { title: 'Meu arquivo' } })]);
  const res = await call('PUT', `/api/songs/${IMPORTED}/lyrics`, { headers: { 'x-room': r.code }, payload: { source: 'lrclib', artist: 'A', title: 'B' } });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'imported_lyrics');
  assert.equal((await claim(agent)).statusCode, 204);
});
