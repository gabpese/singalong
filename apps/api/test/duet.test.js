// Dueto: quem está na sala, o convite (aceitar ou recusar) e o que cada pessoa vê. O client_id de ninguém sai do servidor.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { buildApp } from '../dist/app.js';
import { createMemoryJobStore } from '../dist/jobs.js';
import { pidOf } from '../dist/rooms/rooms.js';
import { LocalStorage } from '../dist/storage.js';

const ANA = 'client-ana-0001';
const BIA = 'client-bia-0001';
const CAIO = 'client-caio-0001';
const SONGS = ['songAlpha01', 'songBravo02', 'songCharl03'];
let app;

before(async () => {
  const root = await mkdtemp(join(tmpdir(), 'singalong-duet-'));
  for (const id of SONGS) {
    const dir = join(root, 'cache', id);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'instrumental.mp3'), Buffer.from('ID3x'));
    await writeFile(join(dir, 'lyrics.json'), '[]');
    await writeFile(join(dir, 'meta.json'), JSON.stringify({ video_id: id, title: `Música ${id}`, artist: 'A' }));
  }
  const loose = { max: 1e6, windowMs: 60_000 };
  app = await buildApp({ config: { publicDir: root, rateLimits: { createRoom: loose, addToQueue: loose } }, storage: new LocalStorage(root), jobs: createMemoryJobStore() });
  await app.ready();
});

after(() => app.close());

async function person(code, client, name, role = 'controller') {
  const sent = [];
  const socket = { readyState: 1, send: (data) => sent.push(JSON.parse(data)), ping() {}, terminate() {} };
  const session = await app.rooms.connect(code, { socket, role, clientId: client, hostToken: '', name });
  return { session, sent, state: () => sent.findLast((m) => m.type === 'state')?.state };
}

const call = async (method, url, client, body) => {
  const res = await app.inject({ method, url: `/api${url}`, headers: { 'x-client-id': client }, payload: body });
  return { status: res.statusCode, body: res.body ? res.json() : null };
};

async function setup() {
  const room = (await app.inject({ method: 'POST', url: '/api/rooms' })).json();
  const code = room.code;
  const ana = await person(code, ANA, 'Ana');
  const bia = await person(code, BIA, 'Bia');
  const caio = await person(code, CAIO, 'Caio');
  // a primeira música começa a tocar na hora; a segunda aguarda (só músicas que aguardam recebem convite)
  const first = await call('POST', `/rooms/${code}/queue`, CAIO, { video_id: SONGS[0], name: 'Caio' });
  const second = await call('POST', `/rooms/${code}/queue`, ANA, { video_id: SONGS[1], name: 'Ana' });
  return { code, room, ana, bia, caio, playingId: first.body.item_id, itemId: second.body.item_id };
}

const item = (state, id) => state.queue.find((i) => i.id === id);

test('a sala sabe quem está nela: nome e um identificador que não revela o client_id', async () => {
  const { code, ana, bia } = await setup();
  const state = (await call('GET', `/rooms/${code}`, ANA)).body;
  assert.deepEqual(state.people.map((p) => p.name).sort(), ['Ana', 'Bia', 'Caio']);
  assert.equal(state.me.pid, pidOf(ANA));
  const json = JSON.stringify(ana.state());
  for (const secret of [ANA, BIA, CAIO]) assert.equal(json.includes(secret), false, 'o client_id vazou');
  assert.equal(new Set(state.people.map((p) => p.pid)).size, 3);
  bia.session.leave(); // quem sai da sala some da lista
  assert.deepEqual((await call('GET', `/rooms/${code}`, ANA)).body.people.map((p) => p.name).sort(), ['Ana', 'Caio']);
});

test('o nome pode mudar depois (mensagem hello do celular) e vale uma pessoa por client_id', async () => {
  const { code, ana } = await setup();
  const second = await person(code, ANA, 'Ana (outra aba)');
  assert.equal((await call('GET', `/rooms/${code}`, ANA)).body.people.filter((p) => p.pid === pidOf(ANA)).length, 1);
  app.rooms.rename(ana.session.conn, '  Aninha  ');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok((await call('GET', `/rooms/${code}`, BIA)).body.people.some((p) => p.name === 'Aninha' || p.name === 'Ana (outra aba)'));
  app.rooms.rename(ana.session.conn, 42); // inválido: ignorado
  second.session.leave();
});

test('convite: o dono convida, o convidado vê o pedido, aceita e os dois aparecem como a dupla', async () => {
  const { code, ana, bia, caio, itemId } = await setup();
  const invite = await call('POST', `/rooms/${code}/queue/${itemId}/invite`, ANA, { pid: pidOf(BIA) });
  assert.equal(invite.status, 200);
  assert.deepEqual(item(invite.body, itemId).guest, { name: 'Bia', status: 'pending' });

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(item(bia.state(), itemId).invite_for_me, true); // só a Bia vê o pedido para ela
  assert.equal(item(bia.state(), itemId).guest_me, false);
  assert.equal(item(ana.state(), itemId).invite_for_me, false);
  assert.equal(item(caio.state(), itemId).invite_for_me, false);
  assert.equal(JSON.stringify(caio.state()).includes(BIA), false);

  const accepted = await call('POST', `/rooms/${code}/queue/${itemId}/invite/respond`, BIA, { accept: true });
  assert.equal(accepted.status, 200);
  const mine = item(accepted.body, itemId);
  assert.deepEqual([mine.guest_me, mine.invite_for_me, mine.guest.status, mine.singers], [true, false, 'accepted', 'Ana & Bia']);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(item(ana.state(), itemId).singers, 'Ana & Bia');
  assert.equal(item(ana.state(), itemId).mine, true);
  assert.equal(item(ana.state(), itemId).guest_me, false);
});

test('recusar ou cancelar desfaz o convite; só o dono (ou o anfitrião) convida e só o convidado responde', async () => {
  const { code, room, bia, itemId } = await setup();
  assert.equal((await call('POST', `/rooms/${code}/queue/${itemId}/invite`, BIA, { pid: pidOf(CAIO) })).status, 403); // não é a música dela
  assert.equal((await call('POST', `/rooms/${code}/queue/${itemId}/invite`, ANA, { pid: pidOf(ANA) })).status, 400); // a si mesma
  assert.equal((await call('POST', `/rooms/${code}/queue/${itemId}/invite`, ANA, { pid: 'aaaaaaaaaa' })).status, 404); // ninguém com esse identificador
  assert.equal((await call('POST', `/rooms/${code}/queue/${itemId}/invite`, ANA, { pid: 'lixo' })).status, 400);

  await call('POST', `/rooms/${code}/queue/${itemId}/invite`, ANA, { pid: pidOf(BIA) });
  assert.equal((await call('POST', `/rooms/${code}/queue/${itemId}/invite/respond`, CAIO, { accept: true })).status, 404); // o convite não é dele
  assert.equal((await call('POST', `/rooms/${code}/queue/${itemId}/invite/respond`, ANA, { accept: true })).status, 404); // nem do dono
  const declined = await call('POST', `/rooms/${code}/queue/${itemId}/invite/respond`, BIA, { accept: false });
  assert.equal(item(declined.body, itemId).guest, null);
  assert.equal((await call('POST', `/rooms/${code}/queue/${itemId}/invite/respond`, BIA, { accept: true })).status, 404); // já foi respondido

  // o anfitrião também pode convidar por alguém, e o dono desfaz
  const host = await app.inject({ method: 'POST', url: `/api/rooms/${code}/queue/${itemId}/invite`, headers: { 'x-client-id': CAIO, 'x-host-token': room.host_token }, payload: { pid: pidOf(BIA) } });
  assert.equal(host.statusCode, 200);
  assert.equal(item(bia.state(), itemId)?.invite_for_me ?? false, true);
  const cancelled = await call('DELETE', `/rooms/${code}/queue/${itemId}/invite`, ANA);
  assert.equal(item(cancelled.body, itemId).guest, null);
  assert.equal((await call('DELETE', `/rooms/${code}/queue/${itemId}/invite`, BIA)).status, 403);
});

test('convidar de novo troca o convidado; a música que já está tocando também recebe convite; o convite some com a música', async () => {
  const { code, itemId, playingId } = await setup();
  await call('POST', `/rooms/${code}/queue/${itemId}/invite`, ANA, { pid: pidOf(BIA) });
  const swapped = await call('POST', `/rooms/${code}/queue/${itemId}/invite`, ANA, { pid: pidOf(CAIO) });
  assert.deepEqual(item(swapped.body, itemId).guest, { name: 'Caio', status: 'pending' });
  // a música que já está tocando também pode ter dueto: quem aceitar entra no meio dela
  const live = await call('POST', `/rooms/${code}/queue/${playingId}/invite`, CAIO, { pid: pidOf(BIA) });
  assert.equal(live.status, 200);
  assert.equal(item(live.body, playingId).status, 'playing');
  assert.deepEqual(item(live.body, playingId).guest, { name: 'Bia', status: 'pending' });
  const joined = await call('POST', `/rooms/${code}/queue/${playingId}/invite/respond`, BIA, { accept: true });
  assert.deepEqual([item(joined.body, playingId).guest_me, item(joined.body, playingId).singers], [true, 'Caio & Bia']);
  assert.equal((await call('POST', `/rooms/${code}/queue/${playingId}/invite`, ANA, { pid: pidOf(BIA) })).status, 403); // só o dono (ou o anfitrião) convida
  await call('DELETE', `/rooms/${code}/queue/${itemId}`, ANA);
  assert.equal(item((await call('GET', `/rooms/${code}`, ANA)).body, itemId), undefined);
});

test('a nota da dupla vai para o placar com os dois nomes', async () => {
  const room = (await app.inject({ method: 'POST', url: '/api/rooms' })).json();
  const code = room.code;
  const ana = await person(code, ANA, 'Ana');
  await person(code, BIA, 'Bia');
  const added = await call('POST', `/rooms/${code}/queue`, ANA, { video_id: SONGS[2], name: 'Ana' });
  await app.inject({ method: 'PATCH', url: `/api/rooms/${code}`, headers: { 'x-client-id': ANA, 'x-host-token': room.host_token }, payload: { scoring: true } });
  // a música da Ana já está tocando, então o convite vale para a próxima: põe outra na fila
  const next = await call('POST', `/rooms/${code}/queue`, ANA, { video_id: SONGS[1], name: 'Ana' });
  await call('POST', `/rooms/${code}/queue/${next.body.item_id}/invite`, ANA, { pid: pidOf(BIA) });
  await call('POST', `/rooms/${code}/queue/${next.body.item_id}/invite/respond`, BIA, { accept: true });
  await person(code, 'tv-client-0001', '', 'tv');
  const scored = app.rooms.tvScore(code, added.body.item_id, 80);
  await app.rooms.tvEnded(code, added.body.item_id);
  await scored;
  const playing = (await call('GET', `/rooms/${code}`, ANA)).body.queue.find((i) => i.id === next.body.item_id);
  assert.equal(playing.status, 'playing'); // a dupla entrou
  await app.rooms.tvScore(code, next.body.item_id, 91);
  const { scoreboard } = (await call('GET', `/rooms/${code}`, ANA)).body;
  assert.deepEqual(scoreboard.find((row) => row.score === 91)?.name, 'Ana & Bia');
  assert.ok(ana.state());
});

// --- a divisão da letra do dueto: quem canta cada linha, escolhido pelos cantores ---
const putParts = (code, videoId, client, parts, host) =>
  app.inject({ method: 'PUT', url: `/api/rooms/${code}/songs/${videoId}/parts`, headers: { 'x-client-id': client, ...(host ? { 'x-host-token': host } : {}) }, payload: { parts } })
    .then((res) => ({ status: res.statusCode, body: res.body ? res.json() : null }));

async function duetOf(code, host) {
  const { itemId } = await (async () => {
    const queued = (await call('GET', `/rooms/${code}`, ANA)).body.queue.find((i) => i.video_id === SONGS[1]);
    return { itemId: queued.id };
  })();
  await call('POST', `/rooms/${code}/queue/${itemId}/invite`, ANA, { pid: pidOf(BIA) });
  await call('POST', `/rooms/${code}/queue/${itemId}/invite/respond`, BIA, { accept: true });
  return itemId;
}

test('dueto: os cantores escolhem quem canta cada linha; o anfitrião também; outra pessoa não', async () => {
  const { code, room, ana, caio } = await setup();
  const itemId = await duetOf(code);
  assert.equal(item((await call('GET', `/rooms/${code}`, ANA)).body, itemId).parts, null); // padrão: automático

  assert.equal((await putParts(code, SONGS[1], ANA, 'ab*-ab')).status, 200); // o dono da música
  assert.equal(item((await call('GET', `/rooms/${code}`, ANA)).body, itemId).parts, 'ab*-ab');
  assert.equal((await putParts(code, SONGS[1], BIA, 'ba*-ba')).status, 200); // o convidado que aceitou
  assert.equal(item((await call('GET', `/rooms/${code}`, BIA)).body, itemId).parts, 'ba*-ba');
  assert.equal((await putParts(code, SONGS[1], CAIO, 'aaaa')).status, 403); // outra pessoa, sem ser anfitrião
  assert.equal((await putParts(code, SONGS[1], CAIO, 'aabb', room.host_token)).status, 200); // o anfitrião
  assert.equal((await putParts(code, SONGS[1], ANA, null)).body.queue.find((i) => i.id === itemId).parts, null); // null volta ao automático

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(item(ana.state(), itemId).parts, null);
  assert.equal(JSON.stringify(caio.state()).includes(ANA), false);
});

test('dueto: só vale com letras a, b, * e -; o tamanho é limitado; a divisão só aparece em música com dueto aceito', async () => {
  const { code, room } = await setup();
  const itemId = await duetOf(code);
  for (const bad of ['abc', 'AB', 'a b', 'ab\n', 'a'.repeat(3001), 42]) {
    assert.equal((await putParts(code, SONGS[1], ANA, bad)).status, 400, String(bad).slice(0, 12));
  }
  assert.equal((await putParts(code, SONGS[1], ANA, 'a'.repeat(3000))).status, 200); // o limite exato vale
  assert.equal((await putParts(code, SONGS[1], ANA, '')).status, 200); // vazio também volta ao automático

  // a música da Caio (sem dueto) não mostra a divisão, mesmo que o anfitrião a defina
  await putParts(code, SONGS[0], ANA, 'abab', room.host_token);
  const state = (await call('GET', `/rooms/${code}`, ANA)).body;
  assert.equal(state.queue.find((i) => i.video_id === SONGS[0]).parts, null);
  assert.equal(item(state, itemId).parts, null);
});
