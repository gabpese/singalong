// The job contract between the API (Node) and the worker (Python).
//
// The worker gets work in two ways (the API never calls the worker; it always PULLS, so it works behind NAT):
//
//  1) The classic worker (Docker, or the owner's PC reading Redis directly), for Rooms WITHOUT a Session:
//   stream  "jobs"        messages {video_id, payload}; payload = JSON {url, lyrics_source, lyrics_text?, artist?, title?}
//   group   "workers"     the consumer group the worker reads (XREADGROUP); ack when done
//   hash    "job:<id>"    state: status (pending|processing|needs_lyrics|ready|failed), stage, error, lyrics_source,
//                         updated_at. The API creates it as "pending"; the worker updates the rest.
//   MP4 export:  list "export:req" (the API LPUSHes {video_id, pitch}); hash "export:<id>:<pitch>" (the worker writes status
//                processing | ready | failed and error; the API creates it as "pending")
//   YouTube search:  list "search:req" (the API LPUSHes {id, q}); list "search:res:<id>" (the worker answers by LPUSHing
//                    {results:[{video_id,title,channel,duration}]} or {error}); key "search:cache:<hash>" is the API's cache of
//                    the results (10 min), so YouTube is not hammered
//
//  2) The local agent (the owner's app, over HTTP at /agent/v1, with no access to Redis), for Rooms OF A SESSION. The same
//     requests go to the Session's own queues, and only the agent that owns it gets them:
//   stream  "jobs:s:<session>"          group "agents"; the consumer is the device's id
//   lists   "search:req:s:<session>" and "export:req:s:<session>"
//   The state stays in "job:<id>" / "export:<id>:<pitch>" (with session_id), and the search answers in "search:res:<id>".
//   A job delivered and without a signal (progress) for STALE_MS goes back to the queue; an agent that restarts gets first
//   what was left pending with it. The hash's "starts" counter holds for both ways (a job that crashes the worker in a loop).
import { createHash, randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { SearchResult } from './protocol.ts';

export const STREAM = 'jobs';
const SEARCH_CACHE_TTL = 600;
export const GROUP = 'workers';
export const AGENT_GROUP = 'agents';
export const STALE_MS = 30 * 60 * 1000;
export const MAX_WAIT_MS = 25_000; // the longest an agent's request waits (long poll)

/** A preparation job's state. */
export interface Job {
  status: string;
  stage: string | null;
  error: string | null;
  /** The failure's stable code (private, too_long, cookies...). */
  error_code: string | null;
  /** auto | manual | never: is it worth trying again? */
  retry: string | null;
  lyrics_source: string | null;
  updated_at: number | null;
  /** The Session (agent) the request belongs to; null or missing = the classic worker. */
  session_id?: string | null;
}

/** What the worker needs to prepare a song. */
export interface JobPayload {
  url: string;
  lyrics_source: string;
  lyrics_text?: string;
  lyrics_loose?: boolean;
  artist?: string;
  title?: string;
}

/** What the agent may write into a job's state (the rest is the API's). */
export interface JobFields {
  stage?: string;
  error?: string;
  error_code?: string;
  retry?: string;
}

/** A job handed to a device: its id, what to do, and which attempt this is. */
export interface ClaimedJob {
  id: string;
  payload: JobPayload;
  attempt: number;
}

export interface ExportStatus {
  status: string;
  error: string | null;
}

/** A search result as the worker or the agent sends it (the API adds the thumbnail). */
export type SearchHit = Omit<SearchResult, 'thumbnail'>;

export interface SearchRequest {
  id: string;
  q: string;
}

export interface ExportRequest {
  video_id: string;
  pitch: number;
}

/** The job queues, in Redis or in memory, with the same meaning. */
export interface JobStore {
  get(id: string): Promise<Job | null>;
  /** Queues the job at once; `{ created: false }` when one is already pending or under way (dedupe). */
  enqueue(id: string, payload: JobPayload, options?: { replace?: boolean; sessionId?: string | null }): Promise<{ created: boolean; job: Job | null }>;
  requestExport(id: string, pitch: number, options?: { sessionId?: string | null }): Promise<ExportStatus | null>;
  exportState(id: string, pitch: number): Promise<ExportStatus | null>;
  /** Asks the classic worker or the Session's agent; it waits up to `timeoutSec` for the answer. */
  search(query: string, options?: { sessionId?: string | null; timeoutSec?: number }): Promise<SearchHit[]>;
  /**
   * The Session's next job for the device: first what was left pending with it (the agent restarted), then another agent's
   * of the same Session that went without a signal, then the new ones (waiting up to `waitMs`). null when there is none.
   */
  claim(sessionId: string, deviceId: string, options?: { waitMs?: number }): Promise<ClaimedJob | null>;
  /** Frees a request stuck with an owner who vanished (pending or under way): it fails, and another owner may ask again. */
  release(id: string): Promise<boolean>;
  /** The progress of a job handed to the device (it renews the "no signal" deadline); false when the job is not its own. */
  progress(id: string, deviceId: string, fields: JobFields): Promise<boolean>;
  /** Ends the job (ready | needs_lyrics | failed): writes the final state and acks it; false when the job is not its own. */
  complete(id: string, deviceId: string, status: string, fields: JobFields): Promise<boolean>;
  /** The Session's next search request, or null. */
  claimSearch(sessionId: string, options?: { waitMs?: number }): Promise<SearchRequest | null>;
  /** A search's answer ({ results } or { error }); false when the request is not this Session's (or expired). */
  replySearch(sessionId: string, id: string, reply: { results?: SearchHit[]; error?: string }): Promise<boolean>;
  /** The Session's next export request, or null. */
  claimExport(sessionId: string, options?: { waitMs?: number }): Promise<ExportRequest | null>;
  /** An export's state (processing | ready | failed); false when the request is not this Session's. */
  setExportState(sessionId: string, id: string, pitch: number, status: string, error?: string): Promise<boolean>;
  /** The Session ended: what nobody will serve fails ("the owner left") and its queues are deleted. */
  abandonSession(sessionId: string): Promise<void>;
  ping(): Promise<boolean>;
  close(): Promise<void>;
}

const jobKey = (id: string) => `job:${id}`;
const sessionStream = (sid: string) => `jobs:s:${sid}`;
const sessionSearch = (sid: string) => `search:req:s:${sid}`;
const sessionExport = (sid: string) => `export:req:s:${sid}`;
const DONE_TTL = 3600;
const FAILED_TTL = 86400;
const TERMINAL = new Set(['ready', 'needs_lyrics', 'failed']);
// what the agent may write into a job's state (the rest is the API's)
const FIELDS = ['stage', 'error', 'error_code', 'retry'] as const;

const OWNER_LEFT = {
  error: 'O dono da sessão saiu antes de a música ser preparada. Peça de novo quando ele voltar.',
  error_code: 'owner_left',
  retry: 'manual',
};

const ENQUEUE = `
local status = redis.call('HGET', KEYS[1], 'status')
if status == 'pending' or status == 'processing' then return 0 end
if status == 'needs_lyrics' and ARGV[1] == '0' then return 0 end
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1], 'status', 'pending', 'stage', '', 'error', '', 'lyrics_source', ARGV[3], 'updated_at', ARGV[2])
if ARGV[6] ~= '' then redis.call('HSET', KEYS[1], 'session_id', ARGV[6]) end
redis.call('XADD', KEYS[2], '*', 'video_id', ARGV[5], 'payload', ARGV[4])
return 1
`;

// an export request: it queues only when none is pending or under way (dedupe). The API asks only when the file does not
// exist, so an old "ready" (its file deleted by the cache cleaning) cannot keep it from being made again.
const REQUEST_EXPORT = `
local status = redis.call('HGET', KEYS[1], 'status')
if status == 'pending' or status == 'processing' then return 0 end
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1], 'status', 'pending', 'error', '', 'updated_at', ARGV[1])
if ARGV[3] ~= '' then redis.call('HSET', KEYS[1], 'session_id', ARGV[3]) end
redis.call('EXPIRE', KEYS[1], 3600)
redis.call('LPUSH', KEYS[2], ARGV[2])
return 1
`;
const exportKey = (id: string, pitch: number) => `export:${id}:${pitch}`;

function toExport(hash: { status?: string | null; error?: string | null } | undefined): ExportStatus | null {
  return hash?.status ? { status: hash.status, error: hash.error || null } : null;
}

function toJob(hash: Record<string, string> | undefined): Job | null {
  if (!hash || !hash.status) return null;
  return {
    status: hash.status,
    stage: hash.stage || null,
    error: hash.error || null,
    error_code: hash.error_code || null,
    retry: hash.retry || null,
    lyrics_source: hash.lyrics_source || null,
    updated_at: hash.updated_at ? Number(hash.updated_at) : null,
    session_id: hash.session_id || null,
  };
}

/** Only the fields the agent may write, as short text. */
function pickFields(body: JobFields = {}): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of FIELDS) {
    if (body[name] !== undefined && body[name] !== null) out[name] = String(body[name]).slice(0, 500);
  }
  return out;
}

const clampWait = (ms: unknown) => Math.max(0, Math.min(Number(ms) || 0, MAX_WAIT_MS));
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Redis's [field, value, ...] pairs as an object. */
function fieldsToObject(flat: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < flat.length; i += 2) out[flat[i]] = flat[i + 1];
  return out;
}

/** A stream entry as ioredis returns it: [id, [field, value, ...]]. */
type StreamEntry = [string, string[]];

/** The Lua scripts above, as commands on the connection. */
type ScriptedRedis = Redis & {
  enqueueJob(...args: (string | number)[]): Promise<number>;
  requestExport(...args: (string | number)[]): Promise<number>;
};

export function createRedisJobStore(connection: Redis, { staleMs = STALE_MS } = {}): JobStore {
  connection.defineCommand('enqueueJob', { numberOfKeys: 2, lua: ENQUEUE });
  connection.defineCommand('requestExport', { numberOfKeys: 2, lua: REQUEST_EXPORT });
  const redis = connection as ScriptedRedis;
  const groups = new Set<string>(); // the Session streams whose group this process already created

  async function ensureGroup(stream: string) {
    if (groups.has(stream)) return;
    try {
      await redis.xgroup('CREATE', stream, AGENT_GROUP, '0', 'MKSTREAM');
    } catch (err) {
      if (!String((err as Error).message).includes('BUSYGROUP')) throw err;
    }
    groups.add(stream);
  }

  /**
   * Records that the job was handed to the device: counts the attempt and keeps where it came from (for progress and the ack).
   * Returns null (and drops the message) when the request already belongs to ANOTHER Session: it was freed and asked again by
   * another owner.
   */
  async function delivered(stream: string, msgId: string, deviceId: string, fields: Record<string, string>, sessionId: string): Promise<ClaimedJob | null> {
    const id = fields.video_id;
    if ((await redis.hget(jobKey(id), 'session_id')) !== sessionId) {
      await redis.xack(stream, AGENT_GROUP, msgId);
      await redis.xdel(stream, msgId);
      return null;
    }
    const attempt = await redis.hincrby(jobKey(id), 'starts', 1);
    await redis.hset(jobKey(id), 'claimed_by', deviceId, 'claim_stream', stream, 'claim_msg', msgId);
    return { id, payload: JSON.parse(fields.payload), attempt: Number(attempt) };
  }

  /** Is the device this job's owner? Returns the hash (with where it was delivered from) or null. */
  async function ownedBy(id: string, deviceId: string) {
    const hash = await redis.hgetall(jobKey(id));
    return hash.claimed_by === deviceId && hash.claim_stream ? hash : null;
  }

  async function blockingPop(list: string, waitMs: number): Promise<string | null> {
    if (!waitMs) return redis.rpop(list);
    const blocking = redis.duplicate(); // BRPOP blocks the connection: it cannot be the shared one
    try {
      const reply = await blocking.brpop(list, Math.max(1, Math.ceil(waitMs / 1000)));
      return reply?.[1] ?? null;
    } finally {
      blocking.disconnect();
    }
  }

  return {
    async get(id) {
      return toJob(await redis.hgetall(jobKey(id)));
    },
    async enqueue(id, payload, { replace = false, sessionId = null } = {}) {
      const created = await redis.enqueueJob(
        jobKey(id), sessionId ? sessionStream(sessionId) : STREAM, replace ? '1' : '0', String(Date.now()), payload.lyrics_source ?? 'auto',
        JSON.stringify(payload), id, sessionId ?? '',
      );
      if (created === 1 && sessionId) await ensureGroup(sessionStream(sessionId));
      return { created: created === 1, job: toJob(await redis.hgetall(jobKey(id))) };
    },
    async requestExport(id, pitch, { sessionId = null } = {}) {
      await redis.requestExport(
        exportKey(id, pitch), sessionId ? sessionExport(sessionId) : 'export:req', String(Date.now()), JSON.stringify({ video_id: id, pitch }), sessionId ?? '',
      );
      return toExport(await redis.hgetall(exportKey(id, pitch)));
    },
    async exportState(id, pitch) {
      return toExport(await redis.hgetall(exportKey(id, pitch)));
    },
    async search(query, { sessionId = null, timeoutSec = 20 } = {}) {
      const q = query.trim();
      const cacheKey = `search:cache:${createHash('sha1').update(q.toLowerCase()).digest('hex')}`;
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached);

      const id = randomUUID();
      const request = JSON.stringify({ id, q });
      const list = sessionId ? sessionSearch(sessionId) : 'search:req';
      if (sessionId) await redis.set(`search:owner:${id}`, sessionId, 'EX', 120);
      await redis.lpush(list, request);
      const blocking = redis.duplicate(); // BRPOP blocks the connection: it cannot be the shared one
      let reply: [string, string] | null;
      try {
        reply = await blocking.brpop(`search:res:${id}`, timeoutSec);
      } finally {
        blocking.disconnect();
      }
      if (!reply) {
        await redis.lrem(list, 0, request); // nobody answered: the request leaves the queue
        throw new Error('search_timeout');
      }
      const { results, error } = JSON.parse(reply[1]);
      if (error) throw new Error(error);
      await redis.set(cacheKey, JSON.stringify(results), 'EX', SEARCH_CACHE_TTL);
      return results;
    },

    // --- the local agent (HTTP): the Session's queues ---

    async claim(sessionId, deviceId, { waitMs = 0 } = {}) {
      const stream = sessionStream(sessionId);
      await ensureGroup(stream);
      const deadline = Date.now() + clampWait(waitMs);
      // each round takes ONE message; orphans (freed requests) are dropped and the next round tries the next one
      for (let round = 0; round < 50; round++) {
        let msg: StreamEntry | undefined;
        const own = (await redis.xreadgroup('GROUP', AGENT_GROUP, deviceId, 'COUNT', 1, 'STREAMS', stream, '0')) as [string, StreamEntry[]][] | null;
        [msg] = own?.[0]?.[1] ?? [];
        if (!msg?.[1]?.length) {
          const stale = (await redis.xautoclaim(stream, AGENT_GROUP, deviceId, staleMs, '0-0', 'COUNT', 1)) as [string, StreamEntry[]];
          [msg] = stale?.[1] ?? [];
        }
        if (!msg?.[1]?.length) {
          const left = deadline - Date.now();
          let reply: [string, StreamEntry[]][] | null;
          if (left > 0) {
            const blocking = redis.duplicate();
            try {
              reply = (await blocking.xreadgroup('GROUP', AGENT_GROUP, deviceId, 'COUNT', 1, 'BLOCK', left, 'STREAMS', stream, '>')) as [string, StreamEntry[]][] | null;
            } finally {
              blocking.disconnect();
            }
          } else {
            reply = (await redis.xreadgroup('GROUP', AGENT_GROUP, deviceId, 'COUNT', 1, 'STREAMS', stream, '>')) as [string, StreamEntry[]][] | null;
          }
          [msg] = reply?.[0]?.[1] ?? [];
        }
        if (!msg?.[1]?.length) return null;
        const job = await delivered(stream, msg[0], deviceId, fieldsToObject(msg[1]), sessionId);
        if (job) return job;
      }
      return null;
    },
    async release(id) {
      const hash = await redis.hgetall(jobKey(id));
      if (!['pending', 'processing'].includes(hash.status)) return false;
      await redis.hset(jobKey(id), { ...OWNER_LEFT, status: 'failed', updated_at: Date.now() });
      await redis.hdel(jobKey(id), 'claimed_by', 'claim_stream', 'claim_msg');
      await redis.expire(jobKey(id), FAILED_TTL);
      return true;
    },
    async progress(id, deviceId, fields) {
      const hash = await ownedBy(id, deviceId);
      if (!hash) return false;
      await redis.hset(jobKey(id), { ...pickFields(fields), status: 'processing', updated_at: Date.now() });
      await redis.xclaim(hash.claim_stream, AGENT_GROUP, deviceId, 0, hash.claim_msg, 'JUSTID');
      return true;
    },
    async complete(id, deviceId, status, fields) {
      const hash = await ownedBy(id, deviceId);
      if (!hash || !TERMINAL.has(status)) return false;
      await redis.hset(jobKey(id), { ...pickFields(fields), status, updated_at: Date.now() });
      await redis.hdel(jobKey(id), 'claimed_by', 'claim_stream', 'claim_msg');
      await redis.expire(jobKey(id), status === 'ready' ? DONE_TTL : FAILED_TTL);
      await redis.xack(hash.claim_stream, AGENT_GROUP, hash.claim_msg);
      await redis.xdel(hash.claim_stream, hash.claim_msg);
      return true;
    },
    async claimSearch(sessionId, { waitMs = 0 } = {}) {
      const raw = await blockingPop(sessionSearch(sessionId), clampWait(waitMs));
      return raw ? JSON.parse(raw) : null;
    },
    async replySearch(sessionId, id, reply) {
      if ((await redis.get(`search:owner:${id}`)) !== sessionId) return false;
      const key = `search:res:${id}`;
      await redis.lpush(key, JSON.stringify(reply.error ? { error: String(reply.error).slice(0, 300) } : { results: reply.results ?? [] }));
      await redis.expire(key, 60);
      await redis.del(`search:owner:${id}`);
      return true;
    },
    async claimExport(sessionId, { waitMs = 0 } = {}) {
      const raw = await blockingPop(sessionExport(sessionId), clampWait(waitMs));
      return raw ? JSON.parse(raw) : null;
    },
    async setExportState(sessionId, id, pitch, status, error = '') {
      const key = exportKey(id, pitch);
      if ((await redis.hget(key, 'session_id')) !== sessionId || !['processing', 'ready', 'failed'].includes(status)) return false;
      await redis.hset(key, { status, error: String(error ?? '').slice(0, 300), updated_at: Date.now() });
      await redis.expire(key, 3600);
      return true;
    },
    async abandonSession(sessionId) {
      const stream = sessionStream(sessionId);
      for (const [, flat] of await redis.xrange(stream, '-', '+')) {
        const id = fieldsToObject(flat).video_id;
        const hash = await redis.hgetall(jobKey(id));
        if (hash.session_id === sessionId && ['pending', 'processing'].includes(hash.status)) {
          await redis.hset(jobKey(id), { ...OWNER_LEFT, status: 'failed', updated_at: Date.now() });
          await redis.hdel(jobKey(id), 'claimed_by', 'claim_stream', 'claim_msg');
          await redis.expire(jobKey(id), FAILED_TTL);
        }
      }
      for (const raw of await redis.lrange(sessionExport(sessionId), 0, -1)) {
        const { video_id: id, pitch } = JSON.parse(raw) as ExportRequest;
        await redis.hset(exportKey(id, pitch), { status: 'failed', error: OWNER_LEFT.error, updated_at: Date.now() });
      }
      await redis.del(stream, sessionSearch(sessionId), sessionExport(sessionId));
      groups.delete(stream);
    },
    async ping() {
      return (await redis.ping()) === 'PONG';
    },
    async close() {
      redis.disconnect();
    },
  };
}

/** The in-memory store also lets the tests act as the worker and look inside the queues. */
export interface MemoryJobStore extends JobStore {
  /** The classic worker's queue. */
  queue: { video_id: string; payload: JobPayload }[];
  exportQueue: ExportRequest[];
  /** What the search returns (or an Error, to fake a failure), and the queries it got. */
  searchResults: SearchHit[] | Error;
  searchQueries: string[];
  /** The Session's jobs not finished yet. */
  sessionJobs(sessionId: string): { video_id: string; payload: JobPayload; starts: number }[];
  /** Acts as the worker updating a job's state. */
  update(id: string, fields: Partial<Job>): void;
  /** Acts as the worker updating an export's state. */
  updateExport(id: string, pitch: number, fields: Partial<ExportStatus>): void;
  search(query: string, options?: { sessionId?: string | null; timeoutMs?: number }): Promise<SearchHit[]>;
}

/** An in-memory store with the same meaning (the tests, and development without Redis). */
export function createMemoryJobStore({ now = Date.now, staleMs = STALE_MS } = {}): MemoryJobStore {
  type Lane = { jobs: { video_id: string; payload: JobPayload; starts: number }[]; search: SearchRequest[]; exports: ExportRequest[] };
  const jobs = new Map<string, Job>();
  const queue: MemoryJobStore['queue'] = [];
  const exports = new Map<string, ExportStatus & { session_id?: string | null }>();
  const sessions = new Map<string, Lane>();
  const claims = new Map<string, { deviceId: string; sessionId: string; at: number }>(); // job id -> who has it
  const waiters = new Map<string, { sessionId: string; resolve: (results: SearchHit[]) => void; reject: (error: Error) => void }>(); // search id -> who waits
  const lane = (sid: string): Lane => {
    if (!sessions.has(sid)) sessions.set(sid, { jobs: [], search: [], exports: [] });
    return sessions.get(sid)!;
  };

  /** Tries `attempt` until it returns something or the wait ends (the in-memory long poll). */
  async function poll<T>(attempt: () => T | null | undefined, waitMs: number): Promise<T | null> {
    const deadline = Date.now() + clampWait(waitMs);
    for (;;) {
      const found = attempt();
      if (found || Date.now() >= deadline) return found ?? null;
      await sleep(5);
    }
  }

  const busy = (job: Job | undefined) => Boolean(job) && (job!.status === 'pending' || job!.status === 'processing');

  return {
    queue,
    exportQueue: [],
    searchResults: [],
    searchQueries: [],
    sessionJobs: (sid) => [...(sessions.get(sid)?.jobs ?? [])],
    async search(query, { sessionId = null, timeoutMs = 20_000 } = {}) {
      this.searchQueries.push(query.trim());
      if (!sessionId) {
        if (this.searchResults instanceof Error) throw this.searchResults;
        return this.searchResults;
      }
      const id = randomUUID();
      lane(sessionId).search.push({ id, q: query.trim() });
      return new Promise<SearchHit[]>((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(id);
          lane(sessionId).search = lane(sessionId).search.filter((r) => r.id !== id);
          reject(new Error('search_timeout'));
        }, timeoutMs);
        timer.unref?.();
        waiters.set(id, {
          sessionId,
          resolve: (results) => {
            clearTimeout(timer);
            resolve(results);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
      });
    },
    async get(id) {
      const job = jobs.get(id);
      // empty fields become null, as in Redis (the agent writes "" to clear one)
      return job ? { ...job, stage: job.stage || null, error: job.error || null, error_code: job.error_code || null, retry: job.retry || null } : null;
    },
    async enqueue(id, payload, { replace = false, sessionId = null } = {}) {
      const current = jobs.get(id);
      if (busy(current) || (current?.status === 'needs_lyrics' && !replace)) return { created: false, job: { ...current! } };
      const job: Job = {
        status: 'pending', stage: null, error: null, error_code: null, retry: null, lyrics_source: payload.lyrics_source ?? 'auto', updated_at: now(),
      };
      jobs.set(id, job);
      claims.delete(id);
      if (sessionId) {
        const entries = lane(sessionId).jobs;
        entries.splice(0, entries.length, ...entries.filter((e) => e.video_id !== id), { video_id: id, payload, starts: 0 });
        job.session_id = sessionId;
      } else {
        queue.push({ video_id: id, payload });
      }
      return { created: true, job: { ...job } };
    },
    async requestExport(id, pitch, { sessionId = null } = {}) {
      const key = exportKey(id, pitch);
      if (!['pending', 'processing'].includes(exports.get(key)?.status ?? '')) {
        exports.set(key, { status: 'pending', error: null, session_id: sessionId });
        if (sessionId) lane(sessionId).exports.push({ video_id: id, pitch });
        else this.exportQueue.push({ video_id: id, pitch });
      }
      return toExport(exports.get(key));
    },
    async exportState(id, pitch) {
      return exports.get(exportKey(id, pitch)) ? toExport(exports.get(exportKey(id, pitch))) : null;
    },
    updateExport(id, pitch, fields) {
      exports.set(exportKey(id, pitch), { ...exports.get(exportKey(id, pitch))!, ...fields });
    },
    update(id, fields) {
      jobs.set(id, { ...jobs.get(id)!, ...fields, updated_at: now() });
    },

    // --- the local agent (HTTP) ---
    async claim(sessionId, deviceId, { waitMs = 0 } = {}) {
      return poll(() => {
        const entries = lane(sessionId).jobs;
        // requests freed and asked again by another owner are no longer this Session's: drop them
        const orphans = entries.filter((e) => jobs.get(e.video_id)?.session_id !== sessionId);
        if (orphans.length) entries.splice(0, entries.length, ...entries.filter((e) => !orphans.includes(e)));
        const entry = entries.find((e) => claims.get(e.video_id)?.deviceId === deviceId) // what was left pending with it
          ?? entries.find((e) => claims.has(e.video_id) && now() - claims.get(e.video_id)!.at >= staleMs) // abandoned by another
          ?? entries.find((e) => !claims.has(e.video_id));
        if (!entry) return null;
        claims.set(entry.video_id, { deviceId, sessionId, at: now() });
        entry.starts += 1;
        return { id: entry.video_id, payload: entry.payload, attempt: entry.starts };
      }, waitMs);
    },
    async release(id) {
      if (!busy(jobs.get(id))) return false;
      jobs.set(id, { ...jobs.get(id)!, ...OWNER_LEFT, status: 'failed', updated_at: now() });
      claims.delete(id);
      return true;
    },
    async progress(id, deviceId, fields) {
      const claim = claims.get(id);
      if (claim?.deviceId !== deviceId) return false;
      claim.at = now();
      jobs.set(id, { ...jobs.get(id)!, ...pickFields(fields), status: 'processing', updated_at: now() });
      return true;
    },
    async complete(id, deviceId, status, fields) {
      const claim = claims.get(id);
      if (claim?.deviceId !== deviceId || !TERMINAL.has(status)) return false;
      jobs.set(id, { ...jobs.get(id)!, ...pickFields(fields), status, updated_at: now() });
      claims.delete(id);
      const entries = lane(claim.sessionId).jobs;
      entries.splice(0, entries.length, ...entries.filter((e) => e.video_id !== id));
      return true;
    },
    async claimSearch(sessionId, { waitMs = 0 } = {}) {
      return poll(() => lane(sessionId).search.shift(), waitMs);
    },
    async replySearch(sessionId, id, reply) {
      const waiter = waiters.get(id);
      if (!waiter || waiter.sessionId !== sessionId) return false;
      waiters.delete(id);
      if (reply.error) waiter.reject(new Error(String(reply.error)));
      else waiter.resolve(reply.results ?? []);
      return true;
    },
    async claimExport(sessionId, { waitMs = 0 } = {}) {
      return poll(() => lane(sessionId).exports.shift(), waitMs);
    },
    async setExportState(sessionId, id, pitch, status, error = '') {
      const key = exportKey(id, pitch);
      if (exports.get(key)?.session_id !== sessionId || !['processing', 'ready', 'failed'].includes(status)) return false;
      exports.set(key, { ...exports.get(key)!, status, error: String(error ?? '').slice(0, 300) });
      return true;
    },
    async abandonSession(sessionId) {
      for (const { video_id: id } of lane(sessionId).jobs) {
        if (jobs.get(id)?.session_id !== sessionId) continue; // already freed and asked again by another owner
        if (busy(jobs.get(id))) jobs.set(id, { ...jobs.get(id)!, ...OWNER_LEFT, status: 'failed', updated_at: now() });
        claims.delete(id);
      }
      for (const { video_id: id, pitch } of lane(sessionId).exports) {
        exports.set(exportKey(id, pitch), { ...exports.get(exportKey(id, pitch))!, status: 'failed', error: OWNER_LEFT.error });
      }
      for (const [id, waiter] of waiters) {
        if (waiter.sessionId === sessionId) {
          waiters.delete(id);
          waiter.reject(new Error('owner_left'));
        }
      }
      sessions.delete(sessionId);
    },
    async ping() {
      return true;
    },
    async close() {},
  };
}
