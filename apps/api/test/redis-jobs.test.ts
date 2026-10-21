// The job store against a real Redis (streams, Lua scripts, long-poll).
// Runs only with REDIS_TEST_URL (e.g. redis://localhost:6390/15): it never uses REDIS_URL, so it never touches a production Redis.
// Uses random ids and deletes what it created (no FLUSHDB).
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, test } from 'node:test';
import { Redis } from 'ioredis';
import { createRedisJobStore } from '../dist/jobs.js';

const URL = process.env.REDIS_TEST_URL;
const skip = URL ? false : 'set REDIS_TEST_URL to run the Redis tests';

let redis;
let store;
const created = new Set(); // keys to clean up
const rid = (n = 6) => randomBytes(n).toString('hex').slice(0, n);
const vid = () => `t${rid(10)}`; // 11 characters
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

test("a Session's job: it goes to the Session's stream, not to the classic worker's 'jobs'", { skip }, async () => {
  const s = sid();
  const classicBefore = await redis.xlen('jobs').catch(() => 0);
  const { id, created: ok } = await enqueueIn(s);
  assert.equal(ok, true);
  assert.equal(await redis.xlen('jobs').catch(() => 0), classicBefore);
  assert.equal(await redis.xlen(`jobs:s:${s}`), 1);
  assert.equal((await redis.hget(`job:${id}`, 'session_id')), s);
  assert.equal((await store.get(id)).status, 'pending');
});

test('dedupe: asking again while it is pending creates no other job', { skip }, async () => {
  const s = sid();
  const { id } = await enqueueIn(s);
  const again = await store.enqueue(id, { lyrics_source: 'auto' }, { sessionId: s });
  assert.equal(again.created, false);
  assert.equal(await redis.xlen(`jobs:s:${s}`), 1);
});

test("claim, progress and completion: only the job's holder; ack takes the job off the queue", { skip }, async () => {
  const s = sid();
  const { id } = await enqueueIn(s);
  const dev = `dev-${rid()}`;
  const got = await store.claim(s, dev);
  assert.equal(got.id, id);
  assert.equal(got.attempt, 1);
  assert.equal(got.payload.lyrics_source, 'auto');
  assert.equal(await store.claim(s, `dev-${rid()}`), null); // another agent does not get what was already delivered

  assert.equal(await store.progress(id, `dev-${rid()}`, { stage: 'x' }), false);
  assert.equal(await store.progress(id, dev, { stage: 'baixando' }), true);
  let job = await store.get(id);
  assert.deepEqual([job.status, job.stage], ['processing', 'baixando']);

  assert.equal(await store.complete(id, `dev-${rid()}`, 'ready', {}), false);
  assert.equal(await store.complete(id, dev, 'inventado', {}), false);
  assert.equal(await store.complete(id, dev, 'ready', { stage: '', error: '' }), true);
  job = await store.get(id);
  assert.equal(job.status, 'ready');
  assert.ok((await redis.ttl(`job:${id}`)) > 0); // the final state expires
  assert.equal((await redis.xpending(`jobs:s:${s}`, 'agents'))[0], 0);
  assert.equal(await redis.xlen(`jobs:s:${s}`), 0);
  assert.equal(await store.progress(id, dev, { stage: 'tarde' }), false); // already finished
});

test('an agent that restarts first gets back what it was holding (the attempt count goes up)', { skip }, async () => {
  const s = sid();
  const { id } = await enqueueIn(s);
  const dev = `dev-${rid()}`;
  assert.equal((await store.claim(s, dev)).attempt, 1);
  const retaken = await store.claim(s, dev);
  assert.deepEqual([retaken.id, retaken.attempt], [id, 2]);
});

test('a job with no sign of life goes to another agent of the Session; progress renews the deadline', { skip }, async () => {
  const s = sid();
  const { id } = await enqueueIn(s);
  const a = `dev-${rid()}`;
  const b = `dev-${rid()}`;
  await store.claim(s, a);
  await sleep(100);
  await store.progress(id, a, { stage: 'vivo' }); // renews
  await sleep(100);
  assert.equal(await store.claim(s, b), null); // only 100 ms since the last sign (< 150)
  await sleep(120);
  const taken = await store.claim(s, b);
  assert.equal(taken.id, id);
  assert.equal(taken.attempt, 2);
  assert.equal(await store.progress(id, a, {}), false); // the old holder lost the job
  assert.equal(await store.progress(id, b, {}), true);
});

test('long-poll: the claim waits and delivers as soon as the job arrives', { skip }, async () => {
  const s = sid();
  const dev = `dev-${rid()}`;
  assert.equal(await store.claim(s, dev), null); // creates the group
  const started = Date.now();
  const waiting = store.claim(s, dev, { waitMs: 3000 });
  await sleep(150);
  const { id } = await enqueueIn(s);
  const got = await waiting;
  assert.equal(got?.id, id);
  assert.ok(Date.now() - started < 2500, 'it should not wait the whole time');
  const t0 = Date.now();
  assert.equal(await store.claim(s, `dev-${rid()}`, { waitMs: 300 }), null); // nothing there: waits and returns null
  assert.ok(Date.now() - t0 >= 250);
});

test("search: the Session's request reaches its agent, and the answer goes back to whoever asked", { skip }, async () => {
  const s = sid();
  track(`search:req:s:${s}`);
  const search = store.search(`consulta ${rid()}`, { sessionId: s, timeoutSec: 5 });
  const request = await store.claimSearch(s, { waitMs: 2000 });
  assert.match(request.q, /^consulta /);
  assert.equal(await store.replySearch(sid(), request.id, { results: [] }), false); // another Session does not answer
  assert.equal(await store.replySearch(s, request.id, { results: [{ video_id: 'abcdefghijk', title: 'T', channel: null, duration: 10 }] }), true);
  const results = await search;
  assert.equal(results[0].video_id, 'abcdefghijk');
  track(`search:cache:${(await import('node:crypto')).createHash('sha1').update(request.q.toLowerCase()).digest('hex')}`);
  assert.equal(await store.replySearch(s, request.id, { results: [] }), false); // already answered
});

test('search: an agent error rejects; with no answer, it times out and takes the request off the queue', { skip }, async () => {
  const s = sid();
  track(`search:req:s:${s}`);
  const outcome = store.search(`falha ${rid()}`, { sessionId: s, timeoutSec: 5 }).then(() => null, (err) => err);
  const request = await store.claimSearch(s, { waitMs: 2000 });
  await store.replySearch(s, request.id, { error: 'bloqueado' });
  assert.match((await outcome)?.message ?? '', /bloqueado/);

  await assert.rejects(store.search(`sem resposta ${rid()}`, { sessionId: s, timeoutSec: 1 }), /search_timeout/);
  assert.equal(await redis.llen(`search:req:s:${s}`), 0);
});

test("export: the Session's request reaches the agent, and only it updates the state", { skip }, async () => {
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
  assert.equal((await store.requestExport(id, 2, { sessionId: s })).status, 'pending'); // it can be asked again after failing
});

test('the owner leaves the Session: pending requests fail with "owner_left" and its queues go away', { skip }, async () => {
  const s = sid();
  const { id } = await enqueueIn(s);
  const done = await enqueueIn(s);
  const dev = `dev-${rid()}`;
  await store.claim(s, dev);
  await store.complete(id, dev, 'ready', {}); // this one finished: it cannot be marked as failed
  const exp = vid();
  track(`export:${exp}:0`);
  await store.requestExport(exp, 0, { sessionId: s });

  await store.abandonSession(s);
  assert.equal((await store.get(id)).status, 'ready');
  const pending = await store.get(done.id);
  assert.deepEqual([pending.status, pending.error_code, pending.retry], ['failed', 'owner_left', 'manual']);
  assert.equal((await store.exportState(exp, 0)).status, 'failed');
  assert.equal(await redis.exists(`jobs:s:${s}`, `export:req:s:${s}`, `search:req:s:${s}`), 0);
  // the abandoned job does not block a new request
  assert.equal((await store.enqueue(done.id, { lyrics_source: 'auto' }, { sessionId: sid() })).created, true);
});

test('a request released and made again by another owner: the old message is dropped and does not go to the old owner', { skip }, async () => {
  const old = sid();
  const fresh = sid();
  const { id } = await enqueueIn(old);
  assert.equal(await store.release(id), true);
  const job = await store.get(id);
  assert.deepEqual([job.status, job.error_code], ['failed', 'owner_left']);
  assert.equal(await store.release(id), false); // no longer pending

  const again = await enqueueIn(fresh, id);
  assert.equal(again.created, true);
  assert.equal((await store.get(id)).session_id, fresh);
  assert.equal(await store.claim(old, `dev-${rid()}`), null); // the old Session's message is dropped
  assert.equal(await redis.xlen(`jobs:s:${old}`), 0);
  const got = await store.claim(fresh, `dev-${rid()}`);
  assert.equal(got.id, id);
  // ending the old Session now does not bring down the new owner's request
  await store.abandonSession(old);
  assert.equal((await store.get(id)).status, 'pending');
});
