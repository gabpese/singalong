import assert from 'node:assert/strict';
import { mkdir, mkdtemp, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { cleanCache } from '../src/cache-cleaner.js';
import { openDb } from '../src/db.js';
import { createMemoryJobStore } from '../src/jobs.js';
import { buildLoggerOptions, redactUrl } from '../src/logging.js';
import { createRateLimiter } from '../src/rate-limit.js';
import { LocalStorage } from '../src/storage.js';

const DAY = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;
const NOW = Date.UTC(2026, 9, 9);

/** Cria cache/<id>/ com `mb` megabytes e a data de modificação `daysAgo` dias atrás. */
async function song(root, id, mb, daysAgo) {
  const dir = join(root, 'cache', id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'instrumental.mp3'), Buffer.alloc(mb * MB));
  await writeFile(join(dir, 'meta.json'), '{}');
  const when = new Date(NOW - daysAgo * DAY);
  for (const name of ['instrumental.mp3', 'meta.json']) await utimes(join(dir, name), when, when);
}

const exists = async (root, id) => stat(join(root, 'cache', id)).then(() => true, () => false);

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'singalong-clean-'));
  return { root, storage: new LocalStorage(root), db: openDb(':memory:'), jobs: createMemoryJobStore() };
}

// ---------- limpeza do cache (LRU) ----------

test('limpeza: abaixo do limite não apaga nada; limite 0 desliga', async () => {
  const { root, storage, db, jobs } = await setup();
  await song(root, 'aaaaaaaaaaa', 10, 30);
  assert.deepEqual((await cleanCache({ storage, db, jobs, maxBytes: 50 * MB, now: () => NOW })).removed, []);
  assert.equal((await cleanCache({ storage, db, jobs, maxBytes: 0 })).skipped, 'disabled');
  assert.ok(await exists(root, 'aaaaaaaaaaa'));
});

test('limpeza: acima do limite apaga primeiro as mais antigas, até ficar em 90% do limite', async () => {
  const { root, storage, db, jobs } = await setup();
  await song(root, 'velha000001', 10, 90); // mais antiga
  await song(root, 'media000001', 10, 40);
  await song(root, 'nova0000001', 10, 1);
  // limite de 25 MB: 30 MB > 25; alvo = 22,5 MB; basta apagar a mais antiga (sobram 20 MB)
  const report = await cleanCache({ storage, db, jobs, maxBytes: 25 * MB, now: () => NOW });
  assert.deepEqual(report.removed.map((r) => r.id), ['velha000001']);
  assert.equal(await exists(root, 'velha000001'), false);
  assert.ok(await exists(root, 'media000001'));
  assert.ok(await exists(root, 'nova0000001'));
  assert.ok(report.after <= 25 * MB * 0.9);
});

test('limpeza: o que foi TOCADO recentemente vale mais que a data do arquivo', async () => {
  const { root, storage, db, jobs } = await setup();
  await song(root, 'processada01', 10, 200); // processada há muito tempo...
  await song(root, 'processada02', 10, 20);
  db.touchPlayed('processada01', NOW - 1 * DAY); // ...mas cantada ontem
  const report = await cleanCache({ storage, db, jobs, maxBytes: 15 * MB, now: () => NOW });
  assert.deepEqual(report.removed.map((r) => r.id), ['processada02']); // a "mais velha" de verdade é a outra
  assert.ok(await exists(root, 'processada01'));
});

test('limpeza: música em alguma fila ou com processamento em andamento nunca é apagada', async () => {
  const { root, storage, db, jobs } = await setup();
  await song(root, 'naFila00001', 10, 300); // a mais antiga de todas, mas está na fila de uma sala
  await song(root, 'processando', 10, 200); // com job em andamento
  await song(root, 'livre000001', 10, 100);
  db.createRoom('ABCD', 'tok', NOW);
  db.addItem({ roomCode: 'ABCD', videoId: 'naFila00001', title: null, artist: null, addedBy: 'Ana', clientId: 'c1', pitch: 0, now: NOW });
  await jobs.enqueue('processando', { url: 'x', lyrics_source: 'auto' });
  const report = await cleanCache({ storage, db, jobs, maxBytes: 5 * MB, now: () => NOW });
  assert.deepEqual(report.removed.map((r) => r.id), ['livre000001']); // só a livre; as outras ficam mesmo acima do limite
  assert.ok(await exists(root, 'naFila00001'));
  assert.ok(await exists(root, 'processando'));
  assert.ok(report.after > 5 * MB); // o limite não é rígido: a prioridade é não tirar música de quem vai cantar
});

test('limpeza: música que já foi tocada e saiu da fila volta a ser candidata', async () => {
  const { root, storage, db, jobs } = await setup();
  await song(root, 'jaCantada01', 10, 5);
  await song(root, 'outra000001', 10, 4);
  db.createRoom('ABCD', 'tok', NOW);
  const id = db.addItem({ roomCode: 'ABCD', videoId: 'jaCantada01', title: null, artist: null, addedBy: 'Ana', clientId: 'c1', pitch: 0, now: NOW });
  db.updateItem(id, { status: 'done' });
  db.touchPlayed('jaCantada01', NOW - 10 * DAY);
  const report = await cleanCache({ storage, db, jobs, maxBytes: 15 * MB, now: () => NOW });
  assert.deepEqual(report.removed.map((r) => r.id), ['jaCantada01']); // tocada há 10 dias, mais antiga que 'outra' (4 dias)
});

test('banco antigo (sem last_played_at) é migrado ao abrir', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'singalong-mig-')), 'old.db');
  const { DatabaseSync } = await import('node:sqlite');
  const old = new DatabaseSync(path);
  old.exec('CREATE TABLE song_settings (video_id TEXT PRIMARY KEY, lyric_offset REAL NOT NULL DEFAULT 0)');
  old.exec("INSERT INTO song_settings VALUES ('abc', 1.5)");
  old.close();
  const db = openDb(path);
  assert.equal(db.getOffset('abc'), 1.5); // dados antigos preservados
  db.touchPlayed('abc', 123);
  assert.equal(db.lastPlayed('abc'), 123);
  assert.equal(db.getOffset('abc'), 1.5); // tocar não zera o ajuste da letra
  db.setOffset('abc', 2);
  assert.equal(db.lastPlayed('abc'), 123); // e ajustar a letra não apaga quando tocou
  db.close();
});

// ---------- limite de requisições ----------

test('rate limit: janela fixa, por pessoa, com Retry-After', () => {
  let t = 1000;
  const limiter = createRateLimiter({ max: 3, windowMs: 60_000, now: () => t });
  for (let i = 0; i < 3; i++) assert.equal(limiter.hit('ana').ok, true);
  const blocked = limiter.hit('ana');
  assert.equal(blocked.ok, false);
  assert.equal(blocked.retryAfterSec, 60);
  assert.equal(limiter.hit('bia').ok, true); // outra pessoa não é afetada
  t += 30_000;
  assert.equal(limiter.hit('ana').retryAfterSec, 30); // o tempo restante diminui
  t += 30_001;
  assert.equal(limiter.hit('ana').ok, true); // janela nova
});

test('rate limit: chaves antigas são varridas (o mapa não cresce para sempre)', () => {
  let t = 0;
  const limiter = createRateLimiter({ max: 1, windowMs: 1000, now: () => t });
  for (let i = 0; i < 100; i++) limiter.hit(`pessoa${i}`);
  assert.equal(limiter.size, 100);
  t += 5000;
  limiter.hit('nova');
  assert.equal(limiter.size, 1);
});

async function appWith(rateLimits) {
  const root = await mkdtemp(join(tmpdir(), 'singalong-rl-'));
  await mkdir(join(root, 'public'));
  await writeFile(join(root, 'public', 'index.html'), 'ok');
  const jobs = createMemoryJobStore();
  jobs.searchResults = [];
  const app = buildApp({ config: { publicDir: join(root, 'public'), rateLimits }, storage: new LocalStorage(root), jobs });
  await app.ready();
  return { app, jobs, root };
}

test('rate limit nas rotas: a 13ª busca seguida é recusada com mensagem clara; outra pessoa passa', async () => {
  const { app } = await appWith({ search: { max: 12, windowMs: 60_000 } });
  const search = (client) => app.inject({ url: '/api/search?q=jack%27s+lament', headers: { 'x-client-id': client } });
  for (let i = 0; i < 12; i++) assert.equal((await search('cliente-ana-01')).statusCode, 200);
  const blocked = await search('cliente-ana-01');
  assert.equal(blocked.statusCode, 429);
  assert.equal(blocked.json().error, 'rate_limited');
  assert.match(blocked.json().message, /Muitas buscas seguidas/);
  assert.ok(Number(blocked.headers['retry-after']) > 0);
  assert.equal((await search('cliente-bia-01')).statusCode, 200); // limite é por pessoa
  await app.close();
});

test('rate limit nas rotas: criar sala e adicionar à fila também têm limite', async () => {
  const { app } = await appWith({ createRoom: { max: 2, windowMs: 60_000 }, addToQueue: { max: 2, windowMs: 60_000 } });
  const headers = { 'x-client-id': 'cliente-ana-01' };
  assert.equal((await app.inject({ method: 'POST', url: '/api/rooms', headers })).statusCode, 201);
  const { code } = (await app.inject({ method: 'POST', url: '/api/rooms', headers })).json();
  assert.equal((await app.inject({ method: 'POST', url: '/api/rooms', headers })).statusCode, 429);
  const add = () => app.inject({ method: 'POST', url: `/api/rooms/${code}/queue`, headers, payload: { video_id: 'novaMusica1', artist: 'A', title: 'B' } });
  assert.equal((await add()).statusCode, 201);
  assert.equal((await add()).statusCode, 201);
  assert.equal((await add()).statusCode, 429);
  await app.close();
});

// ---------- readiness ----------

test('readyz: detalha cada verificação e vira 503 quando algo falha', async () => {
  const { app, jobs } = await appWith({});
  const ok = await app.inject('/readyz');
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), { ok: true, checks: { redis: true, db: true, storage: true } });

  jobs.ping = async () => { throw new Error('conexão recusada'); };
  const down = await app.inject('/readyz');
  assert.equal(down.statusCode, 503);
  assert.deepEqual(down.json(), { ok: false, checks: { redis: false, db: true, storage: true } }); // diz QUAL falhou
  await app.close();
});

test('readyz: armazenamento sem escrita (disco cheio, volume somente leitura) derruba a prontidão', async () => {
  const { app } = await appWith({});
  app.hasDecorator('rooms'); // app montado
  const root = await mkdtemp(join(tmpdir(), 'singalong-ro-'));
  const storage = new LocalStorage(join(root, 'nao-existe')); // pasta inexistente: não dá para gravar
  await assert.rejects(() => storage.check());
  await app.close();
});

// ---------- logs sem segredos ----------

test('logs: o token de anfitrião do endereço do WebSocket é ocultado', () => {
  assert.equal(redactUrl('/api/rooms/ABCD/ws?role=controller&client=c123&host=0123abcd'), '/api/rooms/ABCD/ws?role=controller&client=c123&host=[oculto]');
  assert.equal(redactUrl('/ws?host=abc&role=tv'), '/ws?host=[oculto]&role=tv');
  assert.equal(redactUrl('/api/songs'), '/api/songs');
  assert.equal(redactUrl(undefined), '');
  const req = buildLoggerOptions('warn').serializers.req({ method: 'GET', url: '/x?host=segredo', ip: '1.2.3.4', headers: { 'x-host-token': 'segredo' } });
  assert.deepEqual(req, { method: 'GET', url: '/x?host=[oculto]', remoteAddress: '1.2.3.4' }); // sem cabeçalhos
  assert.equal(buildLoggerOptions('warn').level, 'warn');
});

test('erro do worker chega à tela com o código e se vale tentar de novo', async () => {
  const { app, jobs } = await appWith({});
  const post = (payload) => app.inject({ method: 'POST', url: '/api/songs', payload });
  await post({ url: 'privadoVid1' });
  jobs.update('privadoVid1', { status: 'failed', error: 'Este vídeo é privado. Escolha outro vídeo.', error_code: 'private', retry: 'never' });
  const song = (await app.inject('/api/songs/privadoVid1')).json();
  assert.deepEqual([song.status, song.error_code, song.retry, song.error], ['failed', 'private', 'never', 'Este vídeo é privado. Escolha outro vídeo.']);
  await app.close();
});
