import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import WebSocket from 'ws';
import { buildApp } from '../src/app.js';
import { openDb } from '../src/db.js';
import { createMemoryJobStore } from '../src/jobs.js';
import { LocalStorage } from '../src/storage.js';

const NO_LIMITS = { search: { max: 1e6, windowMs: 60_000 }, addToQueue: { max: 1e6, windowMs: 60_000 }, createRoom: { max: 1e6, windowMs: 60_000 } };
const READY_A = 'readySongA1'; // 11 caracteres, como os IDs do YouTube
const READY_B = 'readySongB1';
const READY_C = 'readySongC1';
const SLOW = 'slowSong001'; // ainda processando
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
  app = buildApp({ config: { publicDir, publicUrl: 'http://192.168.0.10:3000', rateLimits: NO_LIMITS }, storage: new LocalStorage(root), jobs });
  await app.ready();
});

after(() => app.close());

/** Chamada à API como um cliente (e, opcionalmente, como anfitrião). */
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

/** Conexão WebSocket simulada: guarda o que o servidor enviou. */
function fakeConn(code, { role = 'controller', client = ANA, host } = {}) {
  const sent = [];
  const socket = { readyState: 1, send: (data) => sent.push(JSON.parse(data)), ping() {}, terminate() {} };
  const session = app.rooms.connect(code, { socket, role, clientId: client, hostToken: host });
  const lastState = () => sent.findLast((m) => m.type === 'state')?.state;
  return { session, sent, lastState };
}

const add = (code, videoId, opts = {}) => call('POST', `/rooms/${code}/queue`, { ...opts, body: { video_id: videoId, name: opts.name ?? 'Ana', artist: 'Artista', title: 'Título', ...(opts.extra ?? {}) } });
const queueIds = (state) => state.queue.map((i) => i.video_id);

test('criar sala: código curto e fácil de digitar, token de anfitrião, sala inexistente = 404', async () => {
  const { code, host } = await newRoom();
  assert.match(code, /^[A-HJKMNP-Z2-9]{4}$/);
  assert.equal(host.length, 32);
  const state = (await call('GET', `/rooms/${code.toLowerCase()}`)).body; // minúsculas também funcionam
  assert.equal(state.code, code);
  assert.deepEqual([state.playback, state.queue.length, state.fair, state.tv_connected], ['idle', 0, false, false]);
  assert.equal((await call('GET', '/rooms/ZZZZ')).status, 404);
  assert.equal((await call('GET', '/rooms/ab')).status, 400);
});

test('config: endereço público para o QR code', async () => {
  assert.equal((await call('GET', '/config')).body.public_url, 'http://192.168.0.10:3000');
});

test('adicionar: a primeira música pronta começa a tocar; as outras aguardam', async () => {
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
  assert.equal(second.body.state.queue[0].title, `Título ${READY_A}`); // vem do meta.json
  assert.equal(second.body.state.queue[0].song.ready, true);
  assert.equal(second.body.state.queue[0].song.media.instrumental, `/media/cache/${READY_A}/instrumental.mp3`);
});

test('a TV avisa que terminou: avança, e a fila vazia volta a "idle"', async () => {
  const { code } = await newRoom();
  const a = (await add(code, READY_A)).body;
  await add(code, READY_B);
  await app.rooms.tvEnded(code, 999); // item que não é o atual: ignorado (idempotente)
  assert.equal((await call('GET', `/rooms/${code}`)).body.current_item_id, a.item_id);

  await app.rooms.tvEnded(code, a.item_id);
  let state = (await call('GET', `/rooms/${code}`)).body;
  assert.deepEqual(queueIds(state), [READY_B]);
  assert.equal(state.queue[0].status, 'playing');

  await app.rooms.tvEnded(code, a.item_id); // repetido: nada acontece
  assert.equal((await call('GET', `/rooms/${code}`)).body.queue[0].status, 'playing');

  await app.rooms.tvEnded(code, state.current_item_id);
  state = (await call('GET', `/rooms/${code}`)).body;
  assert.deepEqual([state.playback, state.queue.length, state.current_item_id], ['idle', 0, null]);
});

test('música ainda em processamento mantém a posição e a próxima pronta toca antes', async () => {
  const { code } = await newRoom();
  const slow = await add(code, SLOW);
  assert.equal(slow.body.state.playback, 'idle'); // nada pronto ainda
  assert.equal(slow.body.state.queue[0].song.ready, false);
  assert.equal(jobs.queue.some((j) => j.video_id === SLOW), true); // o processamento já começou, por trás dos panos

  const ready = await add(code, READY_A);
  assert.deepEqual(queueIds(ready.body.state), [READY_A, SLOW]); // a pronta toca (e vem primeiro na lista)...
  assert.deepEqual(ready.body.state.queue.map((i) => i.status), ['playing', 'queued']); // ...e a lenta espera sem perder o lugar

  await app.rooms.tvEnded(code, ready.body.item_id);
  assert.equal((await call('GET', `/rooms/${code}`)).body.playback, 'idle'); // a lenta ainda não está pronta

  // o processamento termina: o relógio da sala (tick) a coloca para tocar
  await seed(SLOW);
  jobs.update(SLOW, { status: 'ready' });
  const conn = fakeConn(code);
  await app.rooms.tick();
  const state = conn.lastState();
  assert.deepEqual([state.playback, state.queue[0].video_id, state.queue[0].status], ['playing', SLOW, 'playing']);
  conn.session.leave();
});

test('tick difunde o progresso do processamento e o estado chega só a quem está conectado', async () => {
  const { code } = await newRoom();
  const id = 'progress001';
  await add(code, id);
  const conn = fakeConn(code);
  jobs.update(id, { status: 'processing', stage: 'separating' });
  await app.rooms.tick();
  assert.equal(conn.lastState().queue[0].song.stage, 'separating');
  const before = conn.sent.length;
  await app.rooms.tick(); // nada mudou: não repete a mensagem
  assert.equal(conn.sent.length, before);
  conn.session.leave();
});

test('permissões: anfitrião controla tudo; os demais só as próprias músicas', async () => {
  const { code, host } = await newRoom();
  await add(code, READY_A, { client: ANA });
  const bia1 = (await add(code, READY_B, { client: BIA, name: 'Bia' })).body;

  // quem não é anfitrião não pula, pausa nem reordena
  assert.equal((await call('POST', `/rooms/${code}/player/skip`, { client: BIA })).status, 403);
  assert.equal((await call('POST', `/rooms/${code}/player/pause`, { client: BIA })).status, 403);
  assert.equal((await call('POST', `/rooms/${code}/queue/${bia1.item_id}/move`, { client: BIA, body: { direction: 'up' } })).status, 403); // furar a fila: só o anfitrião
  assert.equal((await call('PATCH', `/rooms/${code}`, { client: BIA, body: { fair: true } })).status, 403);
  // token errado também não vale
  assert.equal((await call('POST', `/rooms/${code}/player/skip`, { client: BIA, host: 'x'.repeat(32) })).status, 403);

  // Ana não remove a música da Bia; a Bia remove a própria
  assert.equal((await call('DELETE', `/rooms/${code}/queue/${bia1.item_id}`, { client: ANA })).status, 403);
  const own = (await call('DELETE', `/rooms/${code}/queue/${bia1.item_id}`, { client: BIA })).body;
  assert.deepEqual(queueIds(own), [READY_A]);

  // o anfitrião remove a de qualquer pessoa
  const bia2 = (await add(code, READY_C, { client: BIA, name: 'Bia' })).body;
  const byHost = (await call('DELETE', `/rooms/${code}/queue/${bia2.item_id}`, { client: ANA, host })).body;
  assert.deepEqual(queueIds(byHost), [READY_A]);
  assert.equal(byHost.me.is_host, true);
  assert.equal((await call('GET', `/rooms/${code}`, { client: BIA })).body.me.is_host, false);
});

test('o estado de cada pessoa tem mine/can_edit e nunca expõe o client_id de ninguém', async () => {
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

test('reordenar: troca com o vizinho; o que está tocando não se move', async () => {
  const { code, host } = await newRoom();
  const a = (await add(code, READY_A)).body;
  const b = (await add(code, READY_B)).body;
  const c = (await add(code, READY_C)).body;
  const move = (id, direction) => call('POST', `/rooms/${code}/queue/${id}/move`, { host, body: { direction } });

  assert.deepEqual(queueIds((await move(c.item_id, 'up')).body), [READY_A, READY_C, READY_B]);
  assert.deepEqual(queueIds((await move(c.item_id, 'up')).body), [READY_A, READY_C, READY_B]); // 1º da fila de espera: sem efeito (A toca)
  assert.deepEqual(queueIds((await move(b.item_id, 'up')).body), [READY_A, READY_B, READY_C]);
  assert.deepEqual(queueIds((await move(c.item_id, 'down')).body), [READY_A, READY_B, READY_C]); // última: sem efeito
  assert.equal((await move(a.item_id, 'down')).status, 409); // tocando
  assert.equal((await move(99999, 'up')).status, 404);
});

test('ceder a vez: o dono adia a própria música em uma posição; subir continua só com o anfitrião', async () => {
  const { code, host } = await newRoom();
  await add(code, READY_A, { client: ANA, name: 'Ana' }); // toca
  const ana = (await add(code, READY_B, { client: ANA, name: 'Ana' })).body;
  const bia = (await add(code, READY_C, { client: BIA, name: 'Bia' })).body;
  const order = async () => queueIds((await call('GET', `/rooms/${code}`)).body);
  const move = (client, itemId, direction, h) => call('POST', `/rooms/${code}/queue/${itemId}/move`, { client, host: h, body: { direction } });

  assert.deepEqual(await order(), [READY_A, READY_B, READY_C]);
  // a Bia não mexe na música da Ana, nem a Ana na da Bia
  assert.equal((await move(BIA, ana.item_id, 'down')).status, 403);
  assert.equal((await move(ANA, bia.item_id, 'down')).status, 403);
  // a Ana cede a vez: a música dela desce uma posição, a da Bia sobe
  assert.deepEqual(queueIds((await move(ANA, ana.item_id, 'down')).body), [READY_A, READY_C, READY_B]);
  // cada ceder adia só uma posição; na última não há para quem ceder (sem efeito)
  assert.deepEqual(queueIds((await move(ANA, ana.item_id, 'down')).body), [READY_A, READY_C, READY_B]);
  // o dono não fura a fila: subir é do anfitrião
  assert.equal((await move(ANA, ana.item_id, 'up')).status, 403);
  assert.deepEqual(queueIds((await move(ANA, ana.item_id, 'up', host)).body), [READY_A, READY_B, READY_C]);
  // o que já está tocando não cede a vez
  assert.equal((await move(ANA, (await call('GET', `/rooms/${code}`)).body.current_item_id, 'down')).status, 409);
  // quem ficou como próximo mudou junto
  await move(ANA, ana.item_id, 'down');
  const state = (await call('GET', `/rooms/${code}`)).body;
  assert.equal(state.queue.find((i) => i.id === state.next_item_id).added_by, 'Bia');
});

test('pular, pausar/retomar e remover o que está tocando', async () => {
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

  const removed = (await call('DELETE', `/rooms/${code}/queue/${skipped.current_item_id}`, { host })).body; // remover o atual = pular
  assert.deepEqual(queueIds(removed), [READY_C]);
  assert.equal(removed.queue[0].status, 'playing');

  const last = (await call('POST', `/rooms/${code}/player/skip`, { host })).body;
  assert.deepEqual([last.playback, last.queue.length], ['idle', 0]);
  assert.equal((await call('POST', `/rooms/${code}/player/pause`, { host })).body.playback, 'idle'); // sem música: segue idle
});

test('tom por música: limitado a ±6, só o dono ou o anfitrião mudam', async () => {
  const { code, host } = await newRoom();
  const a = (await add(code, READY_A, { client: ANA, extra: { pitch: 99 } })).body;
  assert.equal(a.state.queue[0].pitch, 6);
  const patch = (client, pitch, h) => call('PATCH', `/rooms/${code}/queue/${a.item_id}`, { client, host: h, body: { pitch } });
  assert.equal((await patch(ANA, -2)).body.queue[0].pitch, -2);
  assert.equal((await patch(BIA, 1)).status, 403);
  assert.equal((await patch(BIA, -50, host)).body.queue[0].pitch, -6);
});

test('ajuste da letra: só o anfitrião, vale para a música em qualquer sala e é limitado', async () => {
  const one = await newRoom();
  const two = await newRoom();
  await add(one.code, READY_A);
  const put = (code, offset, h) => call('PUT', `/rooms/${code}/songs/${READY_A}/offset`, { host: h, body: { offset } });
  assert.equal((await put(one.code, 1, undefined)).status, 403);
  assert.equal((await put(one.code, 1.5, one.host)).body.queue[0].lyric_offset, 1.5);
  assert.equal((await put(one.code, 99, one.host)).body.queue[0].lyric_offset, 10);
  await add(two.code, READY_A); // outra sala, mesma música
  assert.equal((await call('GET', `/rooms/${two.code}`)).body.queue[0].lyric_offset, 10);
});

test('rodízio justo (opcional): a mesma pessoa não canta duas seguidas', async () => {
  const run = async (fair) => {
    const { code, host } = await newRoom();
    if (fair) await call('PATCH', `/rooms/${code}`, { host, body: { fair: true } });
    const a1 = (await add(code, READY_A, { client: ANA })).body;
    await add(code, READY_B, { client: ANA });
    await add(code, READY_C, { client: BIA, name: 'Bia' });
    await app.rooms.tvEnded(code, a1.item_id);
    const { queue } = (await call('GET', `/rooms/${code}`)).body;
    assert.equal(queue[0].status, 'playing'); // o que toca vem sempre primeiro, mesmo com posição maior
    return queue[0].video_id;
  };
  assert.equal(await run(false), READY_B); // ordem de chegada
  assert.equal(await run(true), READY_C); // a Bia antes da 2ª da Ana
});

test('próximo cantor: segue a regra da fila (pronta, rodízio justo) e some quando não há quem espere', async () => {
  const { code, host } = await newRoom();
  const nextOf = async () => {
    const state = (await call('GET', `/rooms/${code}`)).body;
    return state.queue.find((i) => i.id === state.next_item_id)?.added_by ?? null;
  };
  assert.equal(await nextOf(), null); // sala vazia

  const a1 = (await add(code, READY_A, { client: ANA, name: 'Ana' })).body;
  assert.equal(await nextOf(), null); // só há o que está tocando

  await add(code, 'slowSong002', { client: ANA, name: 'Ana' }); // ainda processando: não conta como "próxima"
  assert.equal(await nextOf(), null);

  await add(code, READY_B, { client: ANA, name: 'Ana' });
  await add(code, READY_C, { client: BIA, name: 'Bia' });
  assert.equal(await nextOf(), 'Ana'); // ordem de chegada: a 2ª da Ana (a lenta é pulada)

  await call('PATCH', `/rooms/${code}`, { host, body: { fair: true } });
  assert.equal(await nextOf(), 'Bia'); // rodízio justo: a Bia antes da 2ª música da Ana
  assert.equal((await call('GET', `/rooms/${code}`)).body.next_item_id !== a1.item_id, true); // nunca o que toca
});

test('validações: link, letra, identificação e limites', async () => {
  const { code } = await newRoom();
  assert.equal((await call('POST', `/rooms/${code}/queue`, { body: { url: 'https://example.com/x' } })).status, 400);
  assert.equal((await call('POST', `/rooms/${code}/queue`, { body: {} })).status, 400);
  assert.equal((await call('POST', `/rooms/${code}/queue`, { client: '', body: { video_id: READY_A } })).status, 400); // sem X-Client-Id
  assert.equal((await call('POST', `/rooms/${code}/queue`, { client: 'curto', body: { video_id: READY_A } })).status, 400);
  assert.equal((await add(code, READY_A, { extra: { lyrics: { source: 'align' } } })).status, 400); // texto obrigatório
  assert.equal((await call('POST', `/rooms/ZZZZ/queue`, { body: { video_id: READY_A } })).status, 404);
  assert.equal((await call('POST', `/rooms/${code}/queue`, { body: { url: `https://youtu.be/${READY_A}` } })).status, 201); // por link

  // limite por pessoa: 20 músicas AGUARDANDO (a que está tocando não conta)
  const other = await newRoom();
  for (let i = 0; i < 21; i++) assert.equal((await add(other.code, READY_A)).status, 201);
  const over = await add(other.code, READY_A);
  assert.equal(over.status, 409);
  assert.equal(over.body.error, 'too_many');
  assert.equal((await add(other.code, READY_B, { client: BIA })).status, 201); // outra pessoa pode
});

test('artista e nome são obrigatórios para música nova; as já prontas (biblioteca) dispensam', async () => {
  const { code } = await newRoom();
  const raw = (body) => call('POST', `/rooms/${code}/queue`, { body });
  const refused = await raw({ video_id: 'novaMusica1', name: 'Ana' });
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error, 'artist_title_required');
  assert.equal((await raw({ video_id: 'novaMusica1', artist: 'Só o artista' })).status, 400);
  assert.equal((await raw({ video_id: 'novaMusica1', artist: '   ', title: 'x' })).status, 400); // espaços não valem
  assert.equal((await raw({ url: 'https://youtu.be/novaMusica1' })).status, 400); // nem por link
  assert.equal((await raw({ video_id: 'novaMusica1', artist: ' Faouzia ', title: ' Unethical ' })).status, 201);
  const job = jobs.queue.findLast((j) => j.video_id === 'novaMusica1');
  assert.deepEqual([job.payload.artist, job.payload.title], ['Faouzia', 'Unethical']); // sem os espaços das pontas
  assert.equal((await raw({ video_id: READY_A })).status, 201); // biblioteca: já pronta, sem artista/nome
});

test('adicionar com letra escolhida cria o job com a escolha (e música em cache só troca a letra)', async () => {
  const { code } = await newRoom();
  await add(code, 'newSong0001', { extra: { lyrics: { source: 'lrclib' }, artist: 'Faouzia', title: 'Unethical', display_title: 'Faouzia - Unethical' } });
  const job = jobs.queue.findLast((j) => j.video_id === 'newSong0001');
  assert.deepEqual([job.payload.lyrics_source, job.payload.artist, job.payload.title], ['lrclib', 'Faouzia', 'Unethical']);
  const state = (await call('GET', `/rooms/${code}`)).body;
  assert.equal(state.queue[0].title, 'Faouzia - Unethical'); // o que o usuário escolheu na pesquisa, até a música ficar pronta

  jobs.update('newSong0001', { status: 'needs_lyrics', error: 'sem letra' });
  const waiting = (await call('GET', `/rooms/${code}`)).body.queue[0].song;
  assert.deepEqual([waiting.status, waiting.error, waiting.ready], ['needs_lyrics', 'sem letra', false]);
});

test('persistência: salas e fila sobrevivem a um reinício (mesmo arquivo SQLite)', async () => {
  const path = join(root, 'persist.db');
  const first = openDb(path);
  first.createRoom('ABCD', 'tok', 1000);
  const id = first.addItem({ roomCode: 'ABCD', videoId: READY_A, title: 't', artist: 'a', addedBy: 'Ana', clientId: ANA, pitch: 2, now: 1000 });
  first.updateRoom('ABCD', { fair: 1 });
  first.close();

  const second = openDb(path);
  assert.equal(second.getRoom('ABCD').fair, 1);
  const [restored] = second.listActive('ABCD');
  assert.deepEqual([restored.id, restored.video_id, restored.pitch, restored.position], [id, READY_A, 2, 1]);
  assert.equal(second.deleteInactiveRooms(2000), 1); // limpeza de salas paradas
  assert.equal(second.getRoom('ABCD'), null);
  assert.deepEqual(second.listActive('ABCD'), []); // os itens vão junto (ON DELETE CASCADE)
  second.close();
});

test('WebSocket real: estado inicial, TV avisa o fim, posição só vai para os controles', async () => {
  const { code, host } = await newRoom();
  const a = (await add(code, READY_A)).body;
  await add(code, READY_B);

  await app.listen({ port: 0, host: '127.0.0.1' });
  const { port } = app.server.address();
  const open = (query) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/rooms/${code}/ws?${query}`);
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
    assert.fail(`tempo esgotado: ${label}`);
  };

  const controller = await open(`role=controller&client=${ANA}&host=${host}`);
  const first = await until(() => controller.messages.find((m) => m.type === 'state'), 'estado inicial');
  assert.equal(first.state.me.is_host, true);
  assert.equal(first.state.queue[0].mine, true);
  assert.equal(first.state.tv_connected, false);

  const tv = await open(`role=tv&client=${BIA}`);
  await until(() => controller.messages.findLast((m) => m.type === 'state')?.state.tv_connected, 'TV conectada');

  tv.ws.send(JSON.stringify({ type: 'position', item_id: a.item_id, ms: 12345 }));
  const position = await until(() => controller.messages.find((m) => m.type === 'position'), 'posição');
  assert.equal(position.ms, 12345);
  assert.equal(tv.messages.some((m) => m.type === 'position'), false); // a TV não recebe a própria posição

  controller.ws.send(JSON.stringify({ type: 'ended', item_id: a.item_id })); // controle não tem esse poder: ignorado
  tv.ws.send(JSON.stringify({ type: 'ended', item_id: a.item_id }));
  const advanced = await until(
    () => controller.messages.findLast((m) => m.type === 'state' && m.state.queue.length === 1 && m.state.queue[0].video_id === READY_B),
    'fila avançou',
  );
  assert.equal(advanced.state.queue[0].status, 'playing');

  tv.ws.close();
  await until(() => controller.messages.findLast((m) => m.type === 'state')?.state.tv_connected === false, 'TV desconectada');
  controller.ws.close();

  const bad = new WebSocket(`ws://127.0.0.1:${port}/api/rooms/ZZZZ/ws?role=tv`);
  const code1008 = await new Promise((resolve) => bad.on('close', (c) => resolve(c)));
  assert.equal(code1008, 1008); // sala inexistente
});

test('pontuação (opcional): só o anfitrião liga; a nota da TV vale só para a música tocando e vai para o placar', async () => {
  const { code, host } = await newRoom();
  assert.equal((await call('PATCH', `/rooms/${code}`, { client: BIA, body: { scoring: true } })).status, 403);
  assert.equal((await call('PATCH', `/rooms/${code}`, { host, body: {} })).status, 400);
  const a = (await add(code, READY_A, { client: ANA })).body;
  await app.rooms.tvScore(code, a.item_id, 80); // desligada: ignorada
  assert.deepEqual((await call('GET', `/rooms/${code}`)).body.scoreboard, []);

  const on = await call('PATCH', `/rooms/${code}`, { host, body: { scoring: true } });
  assert.equal(on.body.scoring, true);
  assert.equal(on.body.fair, false); // um ajuste não mexe no outro

  await app.rooms.tvScore(code, a.item_id, 101); // fora de 0..100: ignorada
  await app.rooms.tvScore(code, a.item_id, 87.5); // não inteira: ignorada
  await app.rooms.tvScore(code, a.item_id, 87);
  await app.rooms.tvEnded(code, a.item_id);
  const b = (await add(code, READY_B, { client: BIA, name: 'Bia' })).body;
  await app.rooms.tvScore(code, b.item_id, 95);
  const { scoreboard } = (await call('GET', `/rooms/${code}`)).body;
  assert.deepEqual(scoreboard.map((r) => [r.name, r.score]), [['Bia', 95], ['Ana', 87]]);
});

test('a melodia de referência só aparece quando existe no cache', async () => {
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
