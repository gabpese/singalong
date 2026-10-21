// The local agent: pairing, Sessions, and routing a Room's requests to the agent that OWNS its Session.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { buildApp } from '../dist/app.js';
import { createMemoryJobStore } from '../dist/jobs.js';
import { LocalStorage } from '../dist/storage.js';
import { fixtures } from './fixtures.ts';

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

async function build(options = {}) {
  const store = options.jobs ?? createMemoryJobStore();
  const instance = await buildApp({
    config: { publicDir: root, adminToken: 'segredo-do-admin', rateLimits: options.rateLimits ?? NO_LIMITS },
    storage: new LocalStorage(root),
    jobs: store,
  });
  return { app: instance, jobs: store };
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'singalong-agent-'));
  ({ app, jobs } = await build());
  await app.ready();
});

after(() => app.close());

const call = (method, url, { headers = {}, payload, application = app } = {}) => application.inject({ method, url, headers, payload });

/** Pairs a new device (the whole path: the administrator makes the code, the agent trades it for a token). */
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

test('pairing: without ADMIN_TOKEN it is off; with it, only the administrator makes the code', async () => {
  const noAdmin = await buildApp({ config: { publicDir: root, rateLimits: NO_LIMITS }, storage: new LocalStorage(root), jobs: createMemoryJobStore() });
  assert.equal((await call('POST', '/agent/v1/pair/start', { headers: ADMIN, payload: {}, application: noAdmin })).statusCode, 404);
  await noAdmin.close();

  assert.equal((await call('POST', '/agent/v1/pair/start', { payload: {} })).statusCode, 403);
  assert.equal((await call('POST', '/agent/v1/pair/start', { headers: { 'x-admin-token': 'errado' }, payload: {} })).statusCode, 403);
  const ok = await call('POST', '/agent/v1/pair/start', { headers: ADMIN, payload: {} });
  assert.equal(ok.statusCode, 201);
  assert.match(ok.json().code, /^[A-Z2-9]{8}$/);
  assert.equal(ok.json().expires_in, 600);
});

test('pairing: the code works once, ignores capitals and spaces, and the token shows only once', async () => {
  const code = (await call('POST', '/agent/v1/pair/start', { headers: ADMIN, payload: {} })).json().code;
  const spaced = `${code.slice(0, 4).toLowerCase()} ${code.slice(4)}`;
  const first = await call('POST', '/agent/v1/pair/complete', { payload: { code: spaced, name: '  Notebook  ' } });
  assert.equal(first.statusCode, 201);
  assert.match(first.json().token, /^sga_/);
  assert.equal((await call('POST', '/agent/v1/pair/complete', { payload: { code } })).statusCode, 400); // already used
  assert.equal((await call('POST', '/agent/v1/pair/complete', { payload: { code: 'ZZZZZZZZ' } })).statusCode, 400);
  assert.equal((await call('GET', '/agent/v1/me', { headers: { authorization: `Bearer ${first.json().token}` } })).json().device.name, 'Notebook');
});

test('pairing: the code expires in 10 minutes', async () => {
  const code = (await call('POST', '/agent/v1/pair/start', { headers: ADMIN, payload: {} })).json().code;
  // ages the code in the database (the service's clock is the process's)
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256').update(code).digest('hex');
  await fixtures(app.orm).savePairCode(hash, Date.now() - 1000);
  assert.equal((await call('POST', '/agent/v1/pair/complete', { payload: { code } })).statusCode, 400);
});

test('pairing: code attempts are limited per person', async () => {
  const limited = await build({ rateLimits: { ...NO_LIMITS, pair: { max: 3, windowMs: 60_000 } } });
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await call('POST', '/agent/v1/pair/complete', { payload: { code: 'AAAAAAAA' }, application: limited.app })).statusCode);
  assert.deepEqual(codes, [400, 400, 400, 429, 429]);
  await limited.app.close();
});

test('authentication: without a token, or with a wrong or revoked one, it is 401', async () => {
  assert.equal((await call('GET', '/agent/v1/me')).statusCode, 401);
  assert.equal((await call('GET', '/agent/v1/me', { headers: { authorization: 'Bearer sga_falso' } })).statusCode, 401);
  const agent = await pair();
  assert.equal((await call('GET', '/agent/v1/me', { headers: agent.headers })).statusCode, 200);
  assert.equal((await call('DELETE', '/agent/v1/devices/me', { headers: agent.headers })).statusCode, 204);
  assert.equal((await call('GET', '/agent/v1/me', { headers: agent.headers })).statusCode, 401);
});

test('Session: the nickname is required and limited; only its owner changes it', async () => {
  const agent = await pair();
  const other = await pair('Outro PC');
  assert.equal((await call('POST', '/agent/v1/sessions', { headers: agent.headers, payload: { display_name: '   ' } })).statusCode, 400);
  const session = await startSession(agent, `  ${'A'.repeat(50)}  `);
  assert.equal(session.display_name.length, 30);
  assert.equal((await call('DELETE', `/agent/v1/sessions/${session.id}`, { headers: other.headers })).statusCode, 404); // from another device
  assert.equal((await call('POST', `/agent/v1/sessions/${session.id}/rooms`, { headers: other.headers, payload: {} })).statusCode, 404);
  assert.equal((await call('GET', '/agent/v1/me', { headers: agent.headers })).json().session.id, session.id);
  assert.equal((await call('DELETE', `/agent/v1/sessions/${session.id}`, { headers: agent.headers })).statusCode, 204);
  assert.equal((await call('GET', '/agent/v1/me', { headers: agent.headers })).json().session, null);
});

test("the Session's Room: the state shows only the owner's nickname and whether they are online", async () => {
  const agent = await pair();
  const session = await startSession(agent, 'Gabriel');
  const room = await makeRoom(agent, session);
  assert.match(room.code, /^[A-Z0-9]{4}$/);
  assert.equal(room.session_id, session.id);
  let state = await roomState(room);
  assert.deepEqual(state.owner, { nickname: 'Gabriel', online: true });
  assert.equal(JSON.stringify(state).includes(session.id), false); // the Session's id does not go to the Guests
  assert.equal(JSON.stringify(state).includes(agent.id), false);

  await fixtures(app.orm).touchSession(session.id, Date.now() - 60_000); // no sign of life for 1 min
  state = await roomState(room);
  assert.equal(state.owner.online, false);
  await call('POST', '/agent/v1/heartbeat', { headers: agent.headers, payload: { version: '0.1.0' } });
  assert.equal((await roomState(room)).owner.online, true);

  const plain = (await call('POST', '/api/rooms')).json(); // a Room without a Session (the classic worker)
  assert.equal((await roomState(plain)).owner, null);
});

test("routing: a Room's request goes only to its Session's agent; the classic worker does not see it", async () => {
  const a = await pair('PC A');
  const b = await pair('PC B');
  const sa = await startSession(a, 'Ana');
  const sb = await startSession(b, 'Beto');
  const room = await makeRoom(a, sa);
  const legacyBefore = jobs.queue.length;

  assert.equal((await addSong(room, 'rotaA000001')).statusCode, 201);
  assert.equal(jobs.queue.length, legacyBefore); // it did not go to the classic worker's queue
  assert.equal((await claim(b)).statusCode, 204); // ANOTHER Session's agent does not get it
  const got = await claim(a);
  assert.equal(got.statusCode, 200);
  assert.equal(got.json().job.id, 'rotaA000001');
  assert.equal(got.json().job.attempt, 1);
  assert.equal(got.json().job.payload.url, 'https://www.youtube.com/watch?v=rotaA000001'); // always the canonical URL
  assert.equal(got.json().job.payload.artist, 'Artista');
  // a second claim by the SAME agent returns the job it was holding (that is how a restarted agent picks it up again)
  const again = await claim(a);
  assert.equal(again.json().job.id, 'rotaA000001');
  assert.equal(again.json().job.attempt, 2);
  assert.equal(sb.id === sa.id, false);
});

test('a Room without a Session stays on the classic worker (the "jobs" queue)', async () => {
  const plain = (await call('POST', '/api/rooms')).json();
  const before = jobs.queue.length;
  assert.equal((await addSong(plain, 'classico001')).statusCode, 201);
  assert.equal(jobs.queue.length, before + 1);
});

test("the job's cycle over HTTP: claim, progress shown in the Room, ready", async () => {
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

  await seed(SONG); // the agent writes the files to the storage
  const done = await call('POST', `/agent/v1/jobs/${job.id}/complete`, { headers: agent.headers, payload: { status: 'ready', stage: '', error: '' } });
  assert.equal(done.statusCode, 204);
  state = await roomState(room);
  assert.equal(state.queue[0].song.ready, true);
  assert.equal(state.queue[0].song.status, 'ready');
});

test('a job that needs lyrics and a job that fails reach the Room with their message', async () => {
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

test('only the agent that got the job can report progress or finish it; the status and the fields are validated', async () => {
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
  // progress never changes the status to a final one: the `status` field is dropped
  assert.equal((await call('POST', `/agent/v1/jobs/${job.id}/progress`, { headers: a.headers, payload: { status: 'ready' } })).statusCode, 204);
  assert.equal((await jobs.get(job.id)).status, 'processing');
  assert.equal((await call('POST', '/agent/v1/jobs/curto/progress', { headers: a.headers, payload: {} })).statusCode, 400);
  assert.equal((await call('POST', `/agent/v1/jobs/${job.id}/progress`, { headers: a.headers, payload: { stage: 'x'.repeat(501) } })).statusCode, 400);
  assert.equal((await claim({ headers: {} })).statusCode, 401);
});

test('claim requires an active Session', async () => {
  const agent = await pair();
  const res = await claim(agent);
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'no_active_session');
});

test('claim with a wait (long-poll): delivers the job as soon as it arrives', async () => {
  const agent = await pair();
  const session = await startSession(agent);
  const room = await makeRoom(agent, session);
  const waiting = call('POST', '/agent/v1/jobs/claim', { headers: agent.headers, payload: { wait_ms: 2000 } });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await addSong(room, 'espera00001');
  const res = await waiting;
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().job.id, 'espera00001');
  assert.equal((await call('POST', '/agent/v1/jobs/claim', { headers: agent.headers, payload: { wait_ms: 999_999 } })).statusCode, 400); // the wait's ceiling
});

test('a job with no sign of life goes back to the queue; an agent that restarts first gets back what it was holding', async () => {
  let clock = 1_000_000;
  const store = createMemoryJobStore({ now: () => clock, staleMs: 60_000 });
  const local = await build({ jobs: store });
  const a = await pair('A', local.app);
  const b = await pair('B', local.app);
  const sa = await startSession(a, 'Ana', {}, local.app);
  const room = await makeRoom(a, sa, local.app);
  await addSong(room, 'volta000001', local.app);

  const first = (await claim(a, local.app)).json().job;
  assert.equal(first.attempt, 1);
  assert.equal((await claim(a, local.app)).statusCode, 200); // the same agent restarted: it gets back what it was holding
  const again = await store.claim(sa.id, a.id);
  assert.equal(again.attempt, 3);
  clock += 30_000;
  await call('POST', `/agent/v1/jobs/${first.id}/progress`, { headers: a.headers, payload: { stage: 'ainda vivo' }, application: local.app });
  clock += 59_000; // 59 s since the last sign: still its own
  assert.equal(await store.claim(sa.id, b.id), null);
  clock += 2_000; // past the deadline with no sign of life
  const taken = await store.claim(sa.id, b.id);
  assert.equal(taken.id, first.id);
  assert.equal(taken.attempt, 4);
  await local.app.close();
});

test('the owner leaves the Session: pending requests fail with a clear message, and the song can be asked for again', async () => {
  const agent = await pair();
  const session = await startSession(agent);
  const room = await makeRoom(agent, session);
  await addSong(room, 'saiu0000001');
  await claim(agent); // running with the agent
  await call('DELETE', `/agent/v1/sessions/${session.id}`, { headers: agent.headers });
  const song = (await roomState(room)).queue[0].song;
  assert.equal(song.status, 'failed');
  assert.equal(song.error_code, 'owner_left');
  assert.equal(song.retry, 'manual');
  assert.match(song.error, /dono da sessão saiu/);
  // another Session can ask for the same song (the old request no longer blocks it)
  const next = await pair('Novo');
  const ns = await startSession(next, 'Novo');
  const nr = await makeRoom(next, ns);
  assert.equal((await addSong(nr, 'saiu0000001')).statusCode, 201);
  assert.equal((await claim(next)).json().job.id, 'saiu0000001');
});

test('starting a new Session ends the earlier one; resuming (resume_id) keeps the Rooms and the requests', async () => {
  const agent = await pair();
  const first = await startSession(agent, 'Primeira');
  const room = await makeRoom(agent, first);
  await addSong(room, 'resume00001');
  const resumed = await startSession(agent, 'Primeira (de volta)', { resume_id: first.id });
  assert.equal(resumed.id, first.id);
  assert.equal(resumed.display_name, 'Primeira (de volta)');
  assert.equal((await claim(agent)).json().job.id, 'resume00001'); // the request stays with it

  const second = await startSession(agent, 'Segunda'); // no resume: ends the earlier one
  assert.notEqual(second.id, first.id);
  assert.equal((await roomState(room)).queue[0].song.error_code, 'owner_left');
});

test("search: the Session's Room is served by its agent; without the owner online, it fails at once", async () => {
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
  assert.equal((await call('POST', `/agent/v1/search/${claimed.json().request.id}/result`, { headers: agent.headers, payload: { results: [] } })).statusCode, 409); // already answered

  await fixtures(app.orm).touchSession(session.id, Date.now() - 60_000); // the owner is offline
  const offline = await call('GET', '/api/search?q=outra+busca', { headers });
  assert.equal(offline.statusCode, 503);
  assert.equal(offline.json().error, 'owner_offline');
  assert.equal((await call('GET', '/api/search?q=qualquer', { headers: { ...CLIENT, 'x-room': 'ZZZZ' } })).statusCode, 404); // a Room that does not exist
});

test('search: only the Session that got the request can answer it; an agent error becomes 503', async () => {
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
  // a malformed result is refused
  assert.equal((await call('POST', `/agent/v1/search/${claimed.id}/result`, { headers: a.headers, payload: { results: [{ video_id: 'curto', title: 'x' }] } })).statusCode, 400);
});

test("MP4 export: the Room's request goes to the Session's agent, which reports its progress", async () => {
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

test("changing a song's lyrics (PUT) also goes to the agent of the Room's Session", async () => {
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

test('the sweep ends the Sessions that went days without a sign of life', async () => {
  const agent = await pair();
  const session = await startSession(agent);
  const room = await makeRoom(agent, session);
  await addSong(room, 'varre000001');
  await fixtures(app.orm).touchSession(session.id, Date.now() - 25 * 60 * 60 * 1000);
  assert.ok((await app.agents.sweep()) >= 1);
  assert.equal((await fixtures(app.orm).getSession(session.id)).endedAt != null, true);
  assert.equal((await roomState(room)).queue[0].song.error_code, 'owner_left');
});

test('an unknown agent route is a JSON 404', async () => {
  const res = await call('GET', '/agent/v1/nao-existe');
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'not_found');
});

test('a request stuck with an owner who vanished is released to whoever asks next; with the owner online, it stays with them', async () => {
  const a = await pair('A');
  const b = await pair('B');
  const sa = await startSession(a, 'Ana');
  const sb = await startSession(b, 'Beto');
  const ra = await makeRoom(a, sa);
  const rb = await makeRoom(b, sb);
  await addSong(ra, 'preso000001');

  await addSong(rb, 'preso000001'); // Ana is online: the request stays with her (dedupe)
  assert.equal((await claim(b)).statusCode, 204);

  await fixtures(app.orm).touchSession(sa.id, Date.now() - 60_000); // Ana vanished
  await addSong(rb, 'preso000001');
  const got = await claim(b);
  assert.equal(got.statusCode, 200);
  assert.equal(got.json().job.id, 'preso000001');

  // Ana is back: her old request no longer exists (it was released and is Beto's now)
  await call('POST', '/agent/v1/heartbeat', { headers: a.headers, payload: {} });
  assert.equal((await claim(a)).statusCode, 204);
  assert.equal((await call('POST', '/agent/v1/jobs/preso000001/progress', { headers: a.headers, payload: { stage: 'x' } })).statusCode, 409);
  assert.equal((await call('POST', '/agent/v1/jobs/preso000001/progress', { headers: b.headers, payload: { stage: 'x' } })).statusCode, 204);
});

test('an owner who leaves does not bring down the request already handed to another owner', async () => {
  const a = await pair('A2');
  const b = await pair('B2');
  const sa = await startSession(a, 'Ana');
  const sb = await startSession(b, 'Beto');
  const ra = await makeRoom(a, sa);
  const rb = await makeRoom(b, sb);
  await addSong(ra, 'passa000001');
  await fixtures(app.orm).touchSession(sa.id, Date.now() - 60_000);
  await addSong(rb, 'passa000001'); // released and asked for again by Beto
  await call('DELETE', `/agent/v1/sessions/${sa.id}`, { headers: a.headers }); // Ana ends her Session afterwards
  const song = (await roomState(rb)).queue.find((i) => i.video_id === 'passa000001').song;
  assert.notEqual(song.error_code, 'owner_left'); // still pending with Beto
  assert.equal((await claim(b)).json().job.id, 'passa000001');
});
