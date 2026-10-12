// Agente local: pareamento, sessões e o roteamento dos pedidos de uma sala para o agente DONO da sessão dela.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { buildApp } from '../src/app.js';
import { createMemoryJobStore } from '../src/jobs.js';
import { LocalStorage } from '../src/storage.js';

const BIG = { max: 1e6, windowMs: 60_000 };
const NO_LIMITS = { search: BIG, addToQueue: BIG, createRoom: BIG, pair: BIG };
const ADMIN = { 'x-admin-token': 'segredo-do-admin' };
const CLIENT = { 'x-client-id': 'cliente-aaaaaaaa' };
const SONG = 'abcdefghijk';
const OTHER = 'lmnopqrstuv';

let root;
let jobs;
let app;

async function seed(id) {
  const dir = join(root, 'cache', id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'instrumental.mp3'), Buffer.from('0123456789'));
  await writeFile(join(dir, 'lyrics.json'), '[]');
  await writeFile(join(dir, 'meta.json'), JSON.stringify({ video_id: id, title: 'T', artist: 'A' }));
}

function build(options = {}) {
  const store = options.jobs ?? createMemoryJobStore();
  const instance = buildApp({
    config: { publicDir: root, adminToken: 'segredo-do-admin', rateLimits: options.rateLimits ?? NO_LIMITS },
    storage: new LocalStorage(root),
    jobs: store,
  });
  return { app: instance, jobs: store };
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'singalong-agent-'));
  ({ app, jobs } = build());
  await app.ready();
});

after(() => app.close());

const call = (method, url, { headers = {}, payload, application = app } = {}) => application.inject({ method, url, headers, payload });

/** Pareia um dispositivo novo (o caminho completo: o administrador gera o código, o agente o troca por um token). */
async function pair(name = 'PC do Gabriel', application = app) {
  const start = await call('POST', '/agent/v1/pair/start', { headers: ADMIN, payload: {}, application });
  assert.equal(start.statusCode, 201);
  const done = await call('POST', '/agent/v1/pair/complete', { payload: { code: start.json().code, name }, application });
  assert.equal(done.statusCode, 201);
  const { token, device_id: id } = done.json();
  return { id, token, headers: { authorization: `Bearer ${token}` } };
}

async function startSession(agent, name = 'Gabriel', extra = {}, application = app) {
  const res = await call('POST', '/agent/v1/sessions', { headers: agent.headers, payload: { display_name: name, ...extra }, application });
  assert.equal(res.statusCode, 201);
  return res.json();
}

async function makeRoom(agent, session, application = app) {
  const res = await call('POST', `/agent/v1/sessions/${session.id}/rooms`, { headers: agent.headers, payload: {}, application });
  assert.equal(res.statusCode, 201);
  return res.json();
}

const addSong = (room, id = SONG, application = app) =>
  call('POST', `/api/rooms/${room.code}/queue`, { headers: CLIENT, payload: { video_id: id, artist: 'Artista', title: 'Música' }, application });

const claim = (agent, application = app) => call('POST', '/agent/v1/jobs/claim', { headers: agent.headers, payload: { wait_ms: 0 }, application });
const roomState = async (room, application = app) => (await call('GET', `/api/rooms/${room.code}`, { headers: CLIENT, application })).json();

test('pareamento: sem ADMIN_TOKEN fica desligado; com ele, só o administrador gera o código', async () => {
  const noAdmin = buildApp({ config: { publicDir: root, rateLimits: NO_LIMITS }, storage: new LocalStorage(root), jobs: createMemoryJobStore() });
  assert.equal((await call('POST', '/agent/v1/pair/start', { headers: ADMIN, payload: {}, application: noAdmin })).statusCode, 404);
  await noAdmin.close();

  assert.equal((await call('POST', '/agent/v1/pair/start', { payload: {} })).statusCode, 403);
  assert.equal((await call('POST', '/agent/v1/pair/start', { headers: { 'x-admin-token': 'errado' }, payload: {} })).statusCode, 403);
  const ok = await call('POST', '/agent/v1/pair/start', { headers: ADMIN, payload: {} });
  assert.equal(ok.statusCode, 201);
  assert.match(ok.json().code, /^[A-Z2-9]{8}$/);
  assert.equal(ok.json().expires_in, 600);
});

test('pareamento: o código é de uso único, ignora maiúsculas/espaços e o token só aparece uma vez', async () => {
  const code = (await call('POST', '/agent/v1/pair/start', { headers: ADMIN, payload: {} })).json().code;
  const spaced = `${code.slice(0, 4).toLowerCase()} ${code.slice(4)}`;
  const first = await call('POST', '/agent/v1/pair/complete', { payload: { code: spaced, name: '  Notebook  ' } });
  assert.equal(first.statusCode, 201);
  assert.match(first.json().token, /^sga_/);
  assert.equal((await call('POST', '/agent/v1/pair/complete', { payload: { code } })).statusCode, 400); // já usado
  assert.equal((await call('POST', '/agent/v1/pair/complete', { payload: { code: 'ZZZZZZZZ' } })).statusCode, 400);
  assert.equal((await call('GET', '/agent/v1/me', { headers: { authorization: `Bearer ${first.json().token}` } })).json().device.name, 'Notebook');
});

test('pareamento: o código vence em 10 minutos', async () => {
  const code = (await call('POST', '/agent/v1/pair/start', { headers: ADMIN, payload: {} })).json().code;
  // envelhece o código no banco (o relógio do serviço é o do processo)
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256').update(code).digest('hex');
  app.db.savePairCode(hash, Date.now() - 1000, Date.now() - 2000);
  assert.equal((await call('POST', '/agent/v1/pair/complete', { payload: { code } })).statusCode, 400);
});

test('pareamento: tentativas de código são limitadas por pessoa', async () => {
  const limited = build({ rateLimits: { ...NO_LIMITS, pair: { max: 3, windowMs: 60_000 } } });
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await call('POST', '/agent/v1/pair/complete', { payload: { code: 'AAAAAAAA' }, application: limited.app })).statusCode);
  assert.deepEqual(codes, [400, 400, 400, 429, 429]);
  await limited.app.close();
});

test('autenticação: sem token, com token errado ou revogado vira 401', async () => {
  assert.equal((await call('GET', '/agent/v1/me')).statusCode, 401);
  assert.equal((await call('GET', '/agent/v1/me', { headers: { authorization: 'Bearer sga_falso' } })).statusCode, 401);
  const agent = await pair();
  assert.equal((await call('GET', '/agent/v1/me', { headers: agent.headers })).statusCode, 200);
  assert.equal((await call('DELETE', '/agent/v1/devices/me', { headers: agent.headers })).statusCode, 204);
  assert.equal((await call('GET', '/agent/v1/me', { headers: agent.headers })).statusCode, 401);
});

test('sessão: apelido obrigatório e limitado; só o dono mexe nela', async () => {
  const agent = await pair();
  const other = await pair('Outro PC');
  assert.equal((await call('POST', '/agent/v1/sessions', { headers: agent.headers, payload: { display_name: '   ' } })).statusCode, 400);
  const session = await startSession(agent, `  ${'A'.repeat(50)}  `);
  assert.equal(session.display_name.length, 30);
  assert.equal((await call('DELETE', `/agent/v1/sessions/${session.id}`, { headers: other.headers })).statusCode, 404); // de outro dispositivo
  assert.equal((await call('POST', `/agent/v1/sessions/${session.id}/rooms`, { headers: other.headers, payload: {} })).statusCode, 404);
  assert.equal((await call('GET', '/agent/v1/me', { headers: agent.headers })).json().session.id, session.id);
  assert.equal((await call('DELETE', `/agent/v1/sessions/${session.id}`, { headers: agent.headers })).statusCode, 204);
  assert.equal((await call('GET', '/agent/v1/me', { headers: agent.headers })).json().session, null);
});

test('sala da sessão: o estado mostra só o apelido do dono e se ele está online', async () => {
  const agent = await pair();
  const session = await startSession(agent, 'Gabriel');
  const room = await makeRoom(agent, session);
  assert.match(room.code, /^[A-Z0-9]{4}$/);
  assert.equal(room.session_id, session.id);
  let state = await roomState(room);
  assert.deepEqual(state.owner, { nickname: 'Gabriel', online: true });
  assert.equal(JSON.stringify(state).includes(session.id), false); // o id da sessão não vai para os convidados
  assert.equal(JSON.stringify(state).includes(agent.id), false);

  app.db.touchSession(session.id, Date.now() - 60_000); // sem sinal há 1 min
  state = await roomState(room);
  assert.equal(state.owner.online, false);
  await call('POST', '/agent/v1/heartbeat', { headers: agent.headers, payload: { version: '0.1.0' } });
  assert.equal((await roomState(room)).owner.online, true);

  const plain = (await call('POST', '/api/rooms')).json(); // sala sem sessão (worker clássico)
  assert.equal((await roomState(plain)).owner, null);
});

test('roteamento: o pedido de uma sala vai só para o agente da sessão dela; o worker clássico não o vê', async () => {
  const a = await pair('PC A');
  const b = await pair('PC B');
  const sa = await startSession(a, 'Ana');
  const sb = await startSession(b, 'Beto');
  const room = await makeRoom(a, sa);
  const legacyBefore = jobs.queue.length;

  assert.equal((await addSong(room, 'rotaA000001')).statusCode, 201);
  assert.equal(jobs.queue.length, legacyBefore); // não foi para a fila do worker clássico
  assert.equal((await claim(b)).statusCode, 204); // o agente de OUTRA sessão não recebe
  const got = await claim(a);
  assert.equal(got.statusCode, 200);
  assert.equal(got.json().job.id, 'rotaA000001');
  assert.equal(got.json().job.attempt, 1);
  assert.equal(got.json().job.payload.url, 'https://www.youtube.com/watch?v=rotaA000001'); // sempre a URL canônica
  assert.equal(got.json().job.payload.artist, 'Artista');
  // um segundo claim do MESMO agente devolve o job que ficou com ele (é assim que um agente que reiniciou o retoma)
  const again = await claim(a);
  assert.equal(again.json().job.id, 'rotaA000001');
  assert.equal(again.json().job.attempt, 2);
  assert.equal(sb.id === sa.id, false);
});

test('sala sem sessão continua no worker clássico (fila "jobs")', async () => {
  const plain = (await call('POST', '/api/rooms')).json();
  const before = jobs.queue.length;
  assert.equal((await addSong(plain, 'classico001')).statusCode, 201);
  assert.equal(jobs.queue.length, before + 1);
});

test('ciclo do job por HTTP: claim, progresso visível na sala, pronto', async () => {
  const agent = await pair();
  const session = await startSession(agent);
  const room = await makeRoom(agent, session);
  await addSong(room, SONG);
  let state = await roomState(room);
  assert.equal(state.queue[0].song.status, 'pending');

  const { job } = (await claim(agent)).json();
  const progress = await call('POST', `/agent/v1/jobs/${job.id}/progress`, { headers: agent.headers, payload: { stage: 'separando a voz' } });
  assert.equal(progress.statusCode, 204);
  state = await roomState(room);
  assert.equal(state.queue[0].song.status, 'processing');
  assert.equal(state.queue[0].song.stage, 'separando a voz');

  await seed(SONG); // o agente grava os arquivos no storage
  const done = await call('POST', `/agent/v1/jobs/${job.id}/complete`, { headers: agent.headers, payload: { status: 'ready', stage: '', error: '' } });
  assert.equal(done.statusCode, 204);
  state = await roomState(room);
  assert.equal(state.queue[0].song.ready, true);
  assert.equal(state.queue[0].song.status, 'ready');
});

test('job que precisa de letra e job que falha chegam à sala com a mensagem', async () => {
  const agent = await pair();
  const session = await startSession(agent);
  const room = await makeRoom(agent, session);
  await addSong(room, 'letra000001');
  await addSong(room, 'falha000001');
  const first = (await claim(agent)).json().job;
  await call('POST', `/agent/v1/jobs/${first.id}/complete`, { headers: agent.headers, payload: { status: 'needs_lyrics', error: 'Este vídeo não tem legenda.' } });
  const second = (await claim(agent)).json().job;
  await call('POST', `/agent/v1/jobs/${second.id}/complete`, {
    headers: agent.headers, payload: { status: 'failed', error: 'Este vídeo é privado.', error_code: 'private', retry: 'never' },
  });
  const byId = Object.fromEntries((await roomState(room)).queue.map((i) => [i.video_id, i.song]));
  assert.equal(byId.letra000001.status, 'needs_lyrics');
  assert.equal(byId.letra000001.error, 'Este vídeo não tem legenda.');
  assert.equal(byId.falha000001.status, 'failed');
  assert.deepEqual([byId.falha000001.error_code, byId.falha000001.retry], ['private', 'never']);
});

test('só o agente que recebeu o job pode dar progresso ou terminá-lo; status e campos são validados', async () => {
  const a = await pair('A');
  const b = await pair('B');
  const sa = await startSession(a);
  await startSession(b);
  const room = await makeRoom(a, sa);
  await addSong(room, 'dono0000001');
  const { job } = (await claim(a)).json();

  const intruder = await call('POST', `/agent/v1/jobs/${job.id}/progress`, { headers: b.headers, payload: { stage: 'x' } });
  assert.equal(intruder.statusCode, 409);
  assert.equal((await call('POST', `/agent/v1/jobs/${job.id}/complete`, { headers: b.headers, payload: { status: 'ready' } })).statusCode, 409);
  assert.equal((await call('POST', `/agent/v1/jobs/${job.id}/complete`, { headers: a.headers, payload: { status: 'inventado' } })).statusCode, 400);
  // o progresso nunca muda o status para um final: o campo `status` é descartado
  assert.equal((await call('POST', `/agent/v1/jobs/${job.id}/progress`, { headers: a.headers, payload: { status: 'ready' } })).statusCode, 204);
  assert.equal((await jobs.get(job.id)).status, 'processing');
  assert.equal((await call('POST', '/agent/v1/jobs/curto/progress', { headers: a.headers, payload: {} })).statusCode, 400);
  assert.equal((await call('POST', `/agent/v1/jobs/${job.id}/progress`, { headers: a.headers, payload: { stage: 'x'.repeat(501) } })).statusCode, 400);
  assert.equal((await claim({ headers: {} })).statusCode, 401);
});

test('claim exige uma sessão ativa', async () => {
  const agent = await pair();
  const res = await claim(agent);
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'no_active_session');
});

test('claim com espera (long-poll): entrega o job assim que ele chega', async () => {
  const agent = await pair();
  const session = await startSession(agent);
  const room = await makeRoom(agent, session);
  const waiting = call('POST', '/agent/v1/jobs/claim', { headers: agent.headers, payload: { wait_ms: 2000 } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await addSong(room, 'espera00001');
  const res = await waiting;
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().job.id, 'espera00001');
  assert.equal((await call('POST', '/agent/v1/jobs/claim', { headers: agent.headers, payload: { wait_ms: 999_999 } })).statusCode, 400); // teto da espera
});

test('job sem sinal volta para a fila; o agente que reinicia recebe primeiro o que ficou com ele', async () => {
  let clock = 1_000_000;
  const store = createMemoryJobStore({ now: () => clock, staleMs: 60_000 });
  const local = build({ jobs: store });
  const a = await pair('A', local.app);
  const b = await pair('B', local.app);
  const sa = await startSession(a, 'Ana', {}, local.app);
  const room = await makeRoom(a, sa, local.app);
  await addSong(room, 'volta000001', local.app);

  const first = (await claim(a, local.app)).json().job;
  assert.equal(first.attempt, 1);
  assert.equal((await claim(a, local.app)).statusCode, 200); // o mesmo agente reiniciou: recebe o que ficou com ele
  const again = await store.claim(sa.id, a.id);
  assert.equal(again.attempt, 3);
  clock += 30_000;
  await call('POST', `/agent/v1/jobs/${first.id}/progress`, { headers: a.headers, payload: { stage: 'ainda vivo' }, application: local.app });
  clock += 59_000; // 59 s desde o último sinal: ainda é dele
  assert.equal(await store.claim(sa.id, b.id), null);
  clock += 2_000; // passou do prazo sem sinal
  const taken = await store.claim(sa.id, b.id);
  assert.equal(taken.id, first.id);
  assert.equal(taken.attempt, 4);
  await local.app.close();
});

test('o dono sai da sessão: os pedidos pendentes falham com uma mensagem clara e a música pode ser pedida de novo', async () => {
  const agent = await pair();
  const session = await startSession(agent);
  const room = await makeRoom(agent, session);
  await addSong(room, 'saiu0000001');
  await claim(agent); // em andamento com o agente
  await call('DELETE', `/agent/v1/sessions/${session.id}`, { headers: agent.headers });
  const song = (await roomState(room)).queue[0].song;
  assert.equal(song.status, 'failed');
  assert.equal(song.error_code, 'owner_left');
  assert.equal(song.retry, 'manual');
  assert.match(song.error, /dono da sessão saiu/);
  // outra sessão pode pedir a mesma música (o pedido antigo não trava mais)
  const next = await pair('Novo');
  const ns = await startSession(next, 'Novo');
  const nr = await makeRoom(next, ns);
  assert.equal((await addSong(nr, 'saiu0000001')).statusCode, 201);
  assert.equal((await claim(next)).json().job.id, 'saiu0000001');
});

test('iniciar uma nova sessão encerra a anterior; retomar (resume_id) mantém as salas e os pedidos', async () => {
  const agent = await pair();
  const first = await startSession(agent, 'Primeira');
  const room = await makeRoom(agent, first);
  await addSong(room, 'resume00001');
  const resumed = await startSession(agent, 'Primeira (de volta)', { resume_id: first.id });
  assert.equal(resumed.id, first.id);
  assert.equal(resumed.display_name, 'Primeira (de volta)');
  assert.equal((await claim(agent)).json().job.id, 'resume00001'); // o pedido continua com ele

  const second = await startSession(agent, 'Segunda'); // sem resume: encerra a anterior
  assert.notEqual(second.id, first.id);
  assert.equal((await roomState(room)).queue[0].song.error_code, 'owner_left');
});

test('busca: a sala da sessão é atendida pelo agente dela; sem o dono online, falha na hora', async () => {
  const agent = await pair();
  const session = await startSession(agent);
  const room = await makeRoom(agent, session);
  const headers = { ...CLIENT, 'x-room': room.code };

  const search = call('GET', '/api/search?q=legiao+urbana', { headers });
  const claimed = await call('POST', '/agent/v1/search/claim', { headers: agent.headers, payload: { wait_ms: 2000 } });
  assert.equal(claimed.statusCode, 200);
  assert.equal(claimed.json().request.q, 'legiao urbana');
  const reply = await call('POST', `/agent/v1/search/${claimed.json().request.id}/result`, {
    headers: agent.headers, payload: { results: [{ video_id: 'YPLQHeUSX2g', title: 'Tempo Perdido', channel: 'Legião', duration: 300 }] },
  });
  assert.equal(reply.statusCode, 204);
  const found = await search;
  assert.equal(found.statusCode, 200);
  assert.equal(found.json()[0].video_id, 'YPLQHeUSX2g');
  assert.match(found.json()[0].thumbnail, /YPLQHeUSX2g/);
  assert.equal((await call('POST', `/agent/v1/search/${claimed.json().request.id}/result`, { headers: agent.headers, payload: { results: [] } })).statusCode, 409); // já respondida

  app.db.touchSession(session.id, Date.now() - 60_000); // dono offline
  const offline = await call('GET', '/api/search?q=outra+busca', { headers });
  assert.equal(offline.statusCode, 503);
  assert.equal(offline.json().error, 'owner_offline');
  assert.equal((await call('GET', '/api/search?q=qualquer', { headers: { ...CLIENT, 'x-room': 'ZZZZ' } })).statusCode, 404); // sala inexistente
});

test('busca: só a sessão que recebeu o pedido pode respondê-lo; erro do agente vira 503', async () => {
  const a = await pair('A');
  const b = await pair('B');
  const sa = await startSession(a);
  await startSession(b);
  const room = await makeRoom(a, sa);
  const headers = { ...CLIENT, 'x-room': room.code };

  const search = call('GET', '/api/search?q=erro+na+busca', { headers });
  const claimed = (await call('POST', '/agent/v1/search/claim', { headers: a.headers, payload: { wait_ms: 2000 } })).json().request;
  assert.equal((await call('POST', '/agent/v1/search/claim', { headers: b.headers, payload: { wait_ms: 0 } })).statusCode, 204);
  assert.equal((await call('POST', `/agent/v1/search/${claimed.id}/result`, { headers: b.headers, payload: { results: [] } })).statusCode, 409);
  assert.equal((await call('POST', `/agent/v1/search/${claimed.id}/result`, { headers: a.headers, payload: { error: 'YouTube bloqueou' } })).statusCode, 204);
  assert.equal((await search).statusCode, 503);
  // resultado malformado é recusado
  assert.equal((await call('POST', `/agent/v1/search/${claimed.id}/result`, { headers: a.headers, payload: { results: [{ video_id: 'curto', title: 'x' }] } })).statusCode, 400);
});

test('exportação de MP4: o pedido da sala vai para o agente da sessão, que informa o andamento', async () => {
  await seed(SONG);
  const agent = await pair();
  const other = await pair('Outro');
  const session = await startSession(agent);
  await startSession(other);
  const room = await makeRoom(agent, session);
  const headers = { 'x-room': room.code };

  const req = await call('POST', `/api/songs/${SONG}/export`, { headers, payload: { pitch: 2 } });
  assert.equal(req.statusCode, 202);
  assert.equal((await call('POST', '/agent/v1/exports/claim', { headers: other.headers, payload: { wait_ms: 0 } })).statusCode, 204);
  const claimed = await call('POST', '/agent/v1/exports/claim', { headers: agent.headers, payload: { wait_ms: 0 } });
  assert.deepEqual(claimed.json().request, { video_id: SONG, pitch: 2 });

  const wrong = await call('POST', `/agent/v1/exports/${SONG}/2/state`, { headers: other.headers, payload: { status: 'ready' } });
  assert.equal(wrong.statusCode, 409);
  assert.equal((await call('POST', `/agent/v1/exports/${SONG}/2/state`, { headers: agent.headers, payload: { status: 'processing' } })).statusCode, 204);
  assert.equal((await call('GET', `/api/songs/${SONG}/export?pitch=2`)).json().status, 'processing');
  await call('POST', `/agent/v1/exports/${SONG}/2/state`, { headers: agent.headers, payload: { status: 'failed', error: 'ffmpeg falhou' } });
  const failed = (await call('GET', `/api/songs/${SONG}/export?pitch=2`)).json();
  assert.deepEqual([failed.status, failed.error], ['failed', 'ffmpeg falhou']);
});

test('trocar a letra de uma música (PUT) também vai para o agente da sessão da sala', async () => {
  await seed(OTHER);
  const agent = await pair();
  const session = await startSession(agent);
  const room = await makeRoom(agent, session);
  const res = await call('PUT', `/api/songs/${OTHER}/lyrics`, { headers: { 'x-room': room.code }, payload: { source: 'lrclib', artist: 'A', title: 'B' } });
  assert.equal(res.statusCode, 202);
  const job = (await claim(agent)).json().job;
  assert.equal(job.id, OTHER);
  assert.equal(job.payload.lyrics_source, 'lrclib');
});

test('a varredura encerra as sessões que ficaram dias sem sinal', async () => {
  const agent = await pair();
  const session = await startSession(agent);
  const room = await makeRoom(agent, session);
  await addSong(room, 'varre000001');
  app.db.touchSession(session.id, Date.now() - 25 * 60 * 60 * 1000);
  assert.ok((await app.agents.sweep()) >= 1);
  assert.equal(app.db.getSession(session.id).ended_at !== null, true);
  assert.equal((await roomState(room)).queue[0].song.error_code, 'owner_left');
});

test('rota desconhecida do agente é 404 JSON', async () => {
  const res = await call('GET', '/agent/v1/nao-existe');
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'not_found');
});
