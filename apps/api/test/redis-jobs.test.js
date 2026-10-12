// Integração do armazenamento de jobs em Redis de verdade (streams, scripts Lua, long-poll).
// Só roda com REDIS_TEST_URL (ex.: redis://localhost:6390/15): nunca usa o REDIS_URL, para não tocar num Redis de produção.
// Usa ids aleatórios e apaga o que criou (sem FLUSHDB).
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Redis } from 'ioredis';
import { createRedisJobStore } from '../src/jobs.js';

const URL = process.env.REDIS_TEST_URL;
const skip = URL ? false : 'defina REDIS_TEST_URL para rodar os testes com Redis';

let redis;
let store;
const created = new Set(); // chaves para limpar
const rid = (n = 6) => randomBytes(n).toString('hex').slice(0, n);
const vid = () => `t${rid(10)}`; // 11 caracteres
const track = (...keys) => keys.forEach((k) => created.add(k));
const sid = () => `sess-${rid(8)}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

before(async () => {
  if (!URL) return;
  redis = new Redis(URL, { maxRetriesPerRequest: 2 });
  store = createRedisJobStore(redis, { staleMs: 150 });
});

after(async () => {
  if (!URL) return;
  if (created.size) await redis.del(...created);
  redis.disconnect();
});

function enqueueIn(session, id = vid(), extra = {}) {
  track(`job:${id}`, `jobs:s:${session}`, `search:req:s:${session}`, `export:req:s:${session}`);
  return store.enqueue(id, { url: `https://www.youtube.com/watch?v=${id}`, lyrics_source: 'auto', ...extra }, { sessionId: session }).then((r) => ({ id, ...r }));
}

test('job de sessão: vai para o stream da sessão, não para o "jobs" do worker clássico', { skip }, async () => {
  const s = sid();
  const classicBefore = await redis.xlen('jobs').catch(() => 0);
  const { id, created: ok } = await enqueueIn(s);
  assert.equal(ok, true);
  assert.equal(await redis.xlen('jobs').catch(() => 0), classicBefore);
  assert.equal(await redis.xlen(`jobs:s:${s}`), 1);
  assert.equal((await redis.hget(`job:${id}`, 'session_id')), s);
  assert.equal((await store.get(id)).status, 'pending');
});

test('dedupe: pedir de novo enquanto está pendente não cria outro job', { skip }, async () => {
  const s = sid();
  const { id } = await enqueueIn(s);
  const again = await store.enqueue(id, { lyrics_source: 'auto' }, { sessionId: s });
  assert.equal(again.created, false);
  assert.equal(await redis.xlen(`jobs:s:${s}`), 1);
});

test('claim, progresso e conclusão: só o dono do job; ack tira o job da fila', { skip }, async () => {
  const s = sid();
  const { id } = await enqueueIn(s);
  const dev = `dev-${rid()}`;
  const got = await store.claim(s, dev);
  assert.equal(got.id, id);
  assert.equal(got.attempt, 1);
  assert.equal(got.payload.lyrics_source, 'auto');
  assert.equal(await store.claim(s, `dev-${rid()}`), null); // outro agente não recebe o que já está entregue

  assert.equal(await store.progress(id, `dev-${rid()}`, { stage: 'x' }), false);
  assert.equal(await store.progress(id, dev, { stage: 'baixando' }), true);
  let job = await store.get(id);
  assert.deepEqual([job.status, job.stage], ['processing', 'baixando']);

  assert.equal(await store.complete(id, `dev-${rid()}`, 'ready', {}), false);
  assert.equal(await store.complete(id, dev, 'inventado', {}), false);
  assert.equal(await store.complete(id, dev, 'ready', { stage: '', error: '' }), true);
  job = await store.get(id);
  assert.equal(job.status, 'ready');
  assert.ok((await redis.ttl(`job:${id}`)) > 0); // o estado final expira
  assert.equal((await redis.xpending(`jobs:s:${s}`, 'agents'))[0], 0);
  assert.equal(await redis.xlen(`jobs:s:${s}`), 0);
  assert.equal(await store.progress(id, dev, { stage: 'tarde' }), false); // já terminou
});

test('o agente que reinicia recebe primeiro o que ficou com ele (a contagem de tentativas sobe)', { skip }, async () => {
  const s = sid();
  const { id } = await enqueueIn(s);
  const dev = `dev-${rid()}`;
  assert.equal((await store.claim(s, dev)).attempt, 1);
  const retaken = await store.claim(s, dev);
  assert.deepEqual([retaken.id, retaken.attempt], [id, 2]);
});

test('job sem sinal volta para outro agente da sessão; progresso renova o prazo', { skip }, async () => {
  const s = sid();
  const { id } = await enqueueIn(s);
  const a = `dev-${rid()}`;
  const b = `dev-${rid()}`;
  await store.claim(s, a);
  await sleep(100);
  await store.progress(id, a, { stage: 'vivo' }); // renova
  await sleep(100);
  assert.equal(await store.claim(s, b), null); // só 100 ms desde o último sinal (< 150)
  await sleep(120);
  const taken = await store.claim(s, b);
  assert.equal(taken.id, id);
  assert.equal(taken.attempt, 2);
  assert.equal(await store.progress(id, a, {}), false); // o antigo dono perdeu o job
  assert.equal(await store.progress(id, b, {}), true);
});

test('long-poll: o claim espera e entrega assim que o job chega', { skip }, async () => {
  const s = sid();
  const dev = `dev-${rid()}`;
  assert.equal(await store.claim(s, dev), null); // cria o grupo
  const started = Date.now();
  const waiting = store.claim(s, dev, { waitMs: 3000 });
  await sleep(150);
  const { id } = await enqueueIn(s);
  const got = await waiting;
  assert.equal(got?.id, id);
  assert.ok(Date.now() - started < 2500, 'não deveria esperar o tempo todo');
  const t0 = Date.now();
  assert.equal(await store.claim(s, `dev-${rid()}`, { waitMs: 300 }), null); // sem nada: espera e devolve null
  assert.ok(Date.now() - t0 >= 250);
});

test('busca: o pedido da sessão chega ao agente dela e a resposta volta a quem pediu', { skip }, async () => {
  const s = sid();
  track(`search:req:s:${s}`);
  const search = store.search(`consulta ${rid()}`, { sessionId: s, timeoutSec: 5 });
  const request = await store.claimSearch(s, { waitMs: 2000 });
  assert.match(request.q, /^consulta /);
  assert.equal(await store.replySearch(sid(), request.id, { results: [] }), false); // outra sessão não responde
  assert.equal(await store.replySearch(s, request.id, { results: [{ video_id: 'abcdefghijk', title: 'T', channel: null, duration: 10 }] }), true);
  const results = await search;
  assert.equal(results[0].video_id, 'abcdefghijk');
  track(`search:cache:${(await import('node:crypto')).createHash('sha1').update(request.q.toLowerCase()).digest('hex')}`);
  assert.equal(await store.replySearch(s, request.id, { results: [] }), false); // já respondida
});

test('busca: erro do agente rejeita; sem resposta, vence e tira o pedido da fila', { skip }, async () => {
  const s = sid();
  track(`search:req:s:${s}`);
  const outcome = store.search(`falha ${rid()}`, { sessionId: s, timeoutSec: 5 }).then(() => null, (err) => err);
  const request = await store.claimSearch(s, { waitMs: 2000 });
  await store.replySearch(s, request.id, { error: 'bloqueado' });
  assert.match((await outcome)?.message ?? '', /bloqueado/);

  await assert.rejects(store.search(`sem resposta ${rid()}`, { sessionId: s, timeoutSec: 1 }), /search_timeout/);
  assert.equal(await redis.llen(`search:req:s:${s}`), 0);
});

test('exportação: o pedido da sessão chega ao agente e só ele atualiza o estado', { skip }, async () => {
  const s = sid();
  const id = vid();
  track(`export:req:s:${s}`, `export:${id}:2`);
  const state = await store.requestExport(id, 2, { sessionId: s });
  assert.equal(state.status, 'pending');
  assert.deepEqual(await store.claimExport(s, { waitMs: 1000 }), { video_id: id, pitch: 2 });
  assert.equal(await store.claimExport(s), null);
  assert.equal(await store.setExportState(sid(), id, 2, 'ready'), false);
  assert.equal(await store.setExportState(s, id, 2, 'inventado'), false);
  assert.equal(await store.setExportState(s, id, 2, 'processing'), true);
  assert.equal(await store.setExportState(s, id, 2, 'failed', 'ffmpeg falhou'), true);
  assert.deepEqual(await store.exportState(id, 2), { status: 'failed', error: 'ffmpeg falhou' });
  assert.equal((await store.requestExport(id, 2, { sessionId: s })).status, 'pending'); // pode pedir de novo depois de falhar
});

test('o dono sai da sessão: pedidos pendentes falham com "owner_left" e as filas dela somem', { skip }, async () => {
  const s = sid();
  const { id } = await enqueueIn(s);
  const done = await enqueueIn(s);
  const dev = `dev-${rid()}`;
  await store.claim(s, dev);
  await store.complete(id, dev, 'ready', {}); // este terminou: não pode ser marcado como falha
  const exp = vid();
  track(`export:${exp}:0`);
  await store.requestExport(exp, 0, { sessionId: s });

  await store.abandonSession(s);
  assert.equal((await store.get(id)).status, 'ready');
  const pending = await store.get(done.id);
  assert.deepEqual([pending.status, pending.error_code, pending.retry], ['failed', 'owner_left', 'manual']);
  assert.equal((await store.exportState(exp, 0)).status, 'failed');
  assert.equal(await redis.exists(`jobs:s:${s}`, `export:req:s:${s}`, `search:req:s:${s}`), 0);
  // o job abandonado não trava um novo pedido
  assert.equal((await store.enqueue(done.id, { lyrics_source: 'auto' }, { sessionId: sid() })).created, true);
});
