// Contrato de jobs entre a API (Node) e o worker (Python).
//
// Dois jeitos de o worker puxar trabalho (a API nunca chama o worker; ele sempre PUXA, então funciona atrás de NAT):
//
//  1) Worker clássico (Docker, o PC do dono lendo o Redis direto), para salas SEM sessão:
//   stream  "jobs"        mensagens {video_id, payload}; payload = JSON {url, lyrics_source, lyrics_text?, artist?, title?}
//   group   "workers"     consumer group lido pelo worker (XREADGROUP); ack ao terminar
//   hash    "job:<id>"    estado: status (pending|processing|needs_lyrics|ready|failed), stage, error,
//                         lyrics_source, updated_at. A API cria como "pending"; o worker atualiza o resto.
//   Exportação em MP4:  lista "export:req" (a API faz LPUSH de {video_id, pitch}); hash "export:<id>:<pitch>" (o worker grava
//                       status processing | ready | failed e error; a API cria como "pending")
//   Busca no YouTube:   lista "search:req" (a API faz LPUSH de {id, q}); lista "search:res:<id>" (o worker responde com LPUSH
//                       de {results:[{video_id,title,channel,duration}]} ou {error}); chave "search:cache:<hash>" é o cache
//                       dos resultados na API (10 min), para não martelar o YouTube
//
//  2) Agente local (o app do dono, por HTTP em /agent/v1, sem acesso ao Redis), para salas DE UMA SESSÃO. Os mesmos pedidos
//     vão para filas próprias da sessão, e só o agente dono dela os recebe:
//   stream  "jobs:s:<sessão>"          group "agents"; o consumidor é o id do dispositivo
//   listas  "search:req:s:<sessão>" e "export:req:s:<sessão>"
//   O estado continua em "job:<id>" / "export:<id>:<pitch>" (com session_id) e as respostas de busca em "search:res:<id>".
//   Um job entregue e sem sinal (progresso) por STALE_MS volta para a fila; o agente que reinicia recebe primeiro o que
//   ficou pendente com ele. O contador "starts" do hash vale para os dois jeitos (job que derruba o worker em loop).

import { createHash, randomUUID } from 'node:crypto';

export const STREAM = 'jobs';
const SEARCH_CACHE_TTL = 600;
export const GROUP = 'workers';
export const AGENT_GROUP = 'agents';
export const STALE_MS = 30 * 60 * 1000;
export const MAX_WAIT_MS = 25_000; // teto da espera (long-poll) de uma requisição do agente

const jobKey = (id) => `job:${id}`;
const sessionStream = (sid) => `jobs:s:${sid}`;
const sessionSearch = (sid) => `search:req:s:${sid}`;
const sessionExport = (sid) => `export:req:s:${sid}`;
const DONE_TTL = 3600;
const FAILED_TTL = 86400;
const TERMINAL = new Set(['ready', 'needs_lyrics', 'failed']);
// o que o agente pode gravar no estado de um job (o resto é da API)
const FIELDS = ['stage', 'error', 'error_code', 'retry'];

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

// pedido de exportação: só enfileira se não há um pendente/em andamento (dedupe). A API só pede quando o arquivo não
// existe, então um "ready" antigo (arquivo apagado pela limpeza do cache) não pode impedir de gerar de novo.
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
const exportKey = (id, pitch) => `export:${id}:${pitch}`;

function toExport(hash) {
  return hash?.status ? { status: hash.status, error: hash.error || null } : null;
}

function toJob(hash) {
  if (!hash || !hash.status) return null;
  return {
    status: hash.status,
    stage: hash.stage || null,
    error: hash.error || null,
    error_code: hash.error_code || null, // código estável da falha (private, too_long, cookies...)
    retry: hash.retry || null, // auto | manual | never: vale tentar de novo?
    lyrics_source: hash.lyrics_source || null,
    updated_at: hash.updated_at ? Number(hash.updated_at) : null,
  };
}

/** Só os campos que o agente pode gravar, como texto curto. */
function pickFields(body = {}) {
  const out = {};
  for (const name of FIELDS) {
    if (body[name] !== undefined && body[name] !== null) out[name] = String(body[name]).slice(0, 500);
  }
  return out;
}

const clampWait = (ms) => Math.max(0, Math.min(Number(ms) || 0, MAX_WAIT_MS));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Os pares [campo, valor, ...] do Redis como objeto. */
function fieldsToObject(flat = []) {
  const out = {};
  for (let i = 0; i < flat.length; i += 2) out[flat[i]] = flat[i + 1];
  return out;
}

/** Enfileira de forma atômica: devolve {created:false} se já há job pendente/em processamento (dedupe). */
export function createRedisJobStore(redis, { staleMs = STALE_MS } = {}) {
  redis.defineCommand('enqueueJob', { numberOfKeys: 2, lua: ENQUEUE });
  redis.defineCommand('requestExport', { numberOfKeys: 2, lua: REQUEST_EXPORT });
  const groups = new Set(); // streams de sessão cujo grupo já foi criado neste processo

  async function ensureGroup(stream) {
    if (groups.has(stream)) return;
    try {
      await redis.xgroup('CREATE', stream, AGENT_GROUP, '0', 'MKSTREAM');
    } catch (err) {
      if (!String(err.message).includes('BUSYGROUP')) throw err;
    }
    groups.add(stream);
  }

  /** Marca a entrega do job ao dispositivo: conta a tentativa e guarda de onde veio (para progresso/ack). */
  async function delivered(stream, msgId, deviceId, fields) {
    const id = fields.video_id;
    const attempt = await redis.hincrby(jobKey(id), 'starts', 1);
    await redis.hset(jobKey(id), 'claimed_by', deviceId, 'claim_stream', stream, 'claim_msg', msgId);
    return { id, payload: JSON.parse(fields.payload), attempt: Number(attempt) };
  }

  /** O dono deste job é o dispositivo? Devolve o hash (com a origem da entrega) ou null. */
  async function ownedBy(id, deviceId) {
    const hash = await redis.hgetall(jobKey(id));
    return hash.claimed_by === deviceId && hash.claim_stream ? hash : null;
  }

  async function blockingPop(list, waitMs) {
    if (!waitMs) return redis.rpop(list);
    const blocking = redis.duplicate(); // BRPOP bloqueia a conexão: não pode ser a compartilhada
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
    async search(query, { timeoutSec = 20, sessionId = null } = {}) {
      const q = query.trim();
      const cacheKey = `search:cache:${createHash('sha1').update(q.toLowerCase()).digest('hex')}`;
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached);

      const id = randomUUID();
      const request = JSON.stringify({ id, q });
      const list = sessionId ? sessionSearch(sessionId) : 'search:req';
      if (sessionId) await redis.set(`search:owner:${id}`, sessionId, 'EX', 120);
      await redis.lpush(list, request);
      const blocking = redis.duplicate(); // BRPOP bloqueia a conexão: não pode ser a compartilhada
      let reply;
      try {
        reply = await blocking.brpop(`search:res:${id}`, timeoutSec);
      } finally {
        blocking.disconnect();
      }
      if (!reply) {
        await redis.lrem(list, 0, request); // ninguém atendeu: tira o pedido da fila
        throw new Error('search_timeout');
      }
      const { results, error } = JSON.parse(reply[1]);
      if (error) throw new Error(error);
      await redis.set(cacheKey, JSON.stringify(results), 'EX', SEARCH_CACHE_TTL);
      return results;
    },

    // --- agente local (HTTP): as filas da sessão ---

    /**
     * Próximo job da sessão para o dispositivo: primeiro o que ficou pendente com ele (o agente reiniciou), depois o de
     * outro agente da mesma sessão que ficou sem sinal, depois os novos (espera até `waitMs`). null se não há nada.
     */
    async claim(sessionId, deviceId, { waitMs = 0 } = {}) {
      const stream = sessionStream(sessionId);
      await ensureGroup(stream);
      const own = await redis.xreadgroup('GROUP', AGENT_GROUP, deviceId, 'COUNT', 1, 'STREAMS', stream, '0');
      const [ownMsg] = own?.[0]?.[1] ?? [];
      if (ownMsg && ownMsg[1]?.length) return delivered(stream, ownMsg[0], deviceId, fieldsToObject(ownMsg[1]));
      const stale = await redis.xautoclaim(stream, AGENT_GROUP, deviceId, staleMs, '0-0', 'COUNT', 1);
      const [staleMsg] = stale?.[1] ?? [];
      if (staleMsg?.[1]?.length) return delivered(stream, staleMsg[0], deviceId, fieldsToObject(staleMsg[1]));

      const wait = clampWait(waitMs);
      let reply;
      if (wait) {
        const blocking = redis.duplicate();
        try {
          reply = await blocking.xreadgroup('GROUP', AGENT_GROUP, deviceId, 'COUNT', 1, 'BLOCK', wait, 'STREAMS', stream, '>');
        } finally {
          blocking.disconnect();
        }
      } else {
        reply = await redis.xreadgroup('GROUP', AGENT_GROUP, deviceId, 'COUNT', 1, 'STREAMS', stream, '>');
      }
      const [msg] = reply?.[0]?.[1] ?? [];
      return msg ? delivered(stream, msg[0], deviceId, fieldsToObject(msg[1])) : null;
    },
    /** Progresso de um job entregue ao dispositivo (renova o prazo de "sem sinal"). false se o job não é dele. */
    async progress(id, deviceId, fields) {
      const hash = await ownedBy(id, deviceId);
      if (!hash) return false;
      await redis.hset(jobKey(id), { ...pickFields(fields), status: 'processing', updated_at: Date.now() });
      await redis.xclaim(hash.claim_stream, AGENT_GROUP, deviceId, 0, hash.claim_msg, 'JUSTID');
      return true;
    },
    /** Termina o job (ready | needs_lyrics | failed): grava o estado final e dá o ack. false se o job não é dele. */
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
    /** Próximo pedido de busca da sessão: { id, q } ou null. */
    async claimSearch(sessionId, { waitMs = 0 } = {}) {
      const raw = await blockingPop(sessionSearch(sessionId), clampWait(waitMs));
      return raw ? JSON.parse(raw) : null;
    },
    /** Resposta de uma busca ({ results } ou { error }). false se o pedido não é desta sessão (ou já venceu). */
    async replySearch(sessionId, id, reply) {
      if ((await redis.get(`search:owner:${id}`)) !== sessionId) return false;
      const key = `search:res:${id}`;
      await redis.lpush(key, JSON.stringify(reply.error ? { error: String(reply.error).slice(0, 300) } : { results: reply.results ?? [] }));
      await redis.expire(key, 60);
      await redis.del(`search:owner:${id}`);
      return true;
    },
    /** Próximo pedido de exportação da sessão: { video_id, pitch } ou null. */
    async claimExport(sessionId, { waitMs = 0 } = {}) {
      const raw = await blockingPop(sessionExport(sessionId), clampWait(waitMs));
      return raw ? JSON.parse(raw) : null;
    },
    /** Estado de uma exportação (processing | ready | failed). false se o pedido não é desta sessão. */
    async setExportState(sessionId, id, pitch, status, error = '') {
      const key = exportKey(id, pitch);
      if ((await redis.hget(key, 'session_id')) !== sessionId || !['processing', 'ready', 'failed'].includes(status)) return false;
      await redis.hset(key, { status, error: String(error ?? '').slice(0, 300), updated_at: Date.now() });
      await redis.expire(key, 3600);
      return true;
    },
    /** A sessão acabou: o que ninguém vai atender vira falha ("o dono saiu") e as filas dela são apagadas. */
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
        const { video_id: id, pitch } = JSON.parse(raw);
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

/** Implementação em memória com a mesma semântica (testes e desenvolvimento sem Redis). */
export function createMemoryJobStore({ now = Date.now, staleMs = STALE_MS } = {}) {
  const jobs = new Map();
  const queue = [];
  const exports = new Map();
  const sessions = new Map(); // sessão -> { jobs: [{video_id, payload}], search: [{id, q}], exports: [{video_id, pitch}] }
  const claims = new Map(); // id do job -> { deviceId, sessionId, at }
  const waiters = new Map(); // id de busca -> { sessionId, resolve, reject }
  const lane = (sid) => {
    if (!sessions.has(sid)) sessions.set(sid, { jobs: [], search: [], exports: [] });
    return sessions.get(sid);
  };

  /** Repete `attempt` até devolver algo ou acabar a espera (a versão em memória do long-poll). */
  async function poll(attempt, waitMs) {
    const deadline = Date.now() + clampWait(waitMs);
    for (;;) {
      const found = attempt();
      if (found || Date.now() >= deadline) return found ?? null;
      await sleep(5);
    }
  }

  const busy = (job) => job && (job.status === 'pending' || job.status === 'processing');

  return {
    queue,
    exportQueue: [],
    /** Resultados que a busca devolve (ou um Error para simular falha) e as consultas recebidas. */
    searchResults: [],
    searchQueries: [],
    /** Os jobs ainda não terminados da sessão (para os testes). */
    sessionJobs: (sid) => [...(sessions.get(sid)?.jobs ?? [])],
    async search(query, { sessionId = null, timeoutMs = 20_000 } = {}) {
      this.searchQueries.push(query.trim());
      if (!sessionId) {
        if (this.searchResults instanceof Error) throw this.searchResults;
        return this.searchResults;
      }
      const id = randomUUID();
      lane(sessionId).search.push({ id, q: query.trim() });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          waiters.delete(id);
          lane(sessionId).search = lane(sessionId).search.filter((r) => r.id !== id);
          reject(new Error('search_timeout'));
        }, timeoutMs);
        timer.unref?.();
        waiters.set(id, { sessionId, resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
      });
    },
    async get(id) {
      const job = jobs.get(id);
      // campos vazios viram null, como no Redis (o agente grava "" para limpar)
      return job ? { ...job, stage: job.stage || null, error: job.error || null, error_code: job.error_code || null, retry: job.retry || null } : null;
    },
    async enqueue(id, payload, { replace = false, sessionId = null } = {}) {
      const current = jobs.get(id);
      if (busy(current) || (current?.status === 'needs_lyrics' && !replace)) return { created: false, job: { ...current } };
      const job = {
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
      if (!['pending', 'processing'].includes(exports.get(key)?.status)) {
        exports.set(key, { status: 'pending', error: null, session_id: sessionId });
        if (sessionId) lane(sessionId).exports.push({ video_id: id, pitch });
        else this.exportQueue.push({ video_id: id, pitch });
      }
      return toExport(exports.get(key));
    },
    async exportState(id, pitch) {
      return exports.get(exportKey(id, pitch)) ? toExport(exports.get(exportKey(id, pitch))) : null;
    },
    /** Simula o worker atualizando o estado de uma exportação. */
    updateExport(id, pitch, fields) {
      exports.set(exportKey(id, pitch), { ...exports.get(exportKey(id, pitch)), ...fields });
    },
    /** Simula o worker atualizando o estado. */
    update(id, fields) {
      jobs.set(id, { ...jobs.get(id), ...fields, updated_at: now() });
    },

    // --- agente local (HTTP) ---
    async claim(sessionId, deviceId, { waitMs = 0 } = {}) {
      return poll(() => {
        const entries = lane(sessionId).jobs;
        const entry = entries.find((e) => claims.get(e.video_id)?.deviceId === deviceId) // o que ficou pendente com ele
          ?? entries.find((e) => claims.has(e.video_id) && now() - claims.get(e.video_id).at >= staleMs) // abandonado por outro
          ?? entries.find((e) => !claims.has(e.video_id));
        if (!entry) return null;
        claims.set(entry.video_id, { deviceId, sessionId, at: now() });
        entry.starts += 1;
        return { id: entry.video_id, payload: entry.payload, attempt: entry.starts };
      }, waitMs);
    },
    async progress(id, deviceId, fields) {
      const claim = claims.get(id);
      if (claim?.deviceId !== deviceId) return false;
      claim.at = now();
      jobs.set(id, { ...jobs.get(id), ...pickFields(fields), status: 'processing', updated_at: now() });
      return true;
    },
    async complete(id, deviceId, status, fields) {
      const claim = claims.get(id);
      if (claim?.deviceId !== deviceId || !TERMINAL.has(status)) return false;
      jobs.set(id, { ...jobs.get(id), ...pickFields(fields), status, updated_at: now() });
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
      exports.set(key, { ...exports.get(key), status, error: String(error ?? '').slice(0, 300) });
      return true;
    },
    async abandonSession(sessionId) {
      for (const { video_id: id } of lane(sessionId).jobs) {
        if (busy(jobs.get(id))) jobs.set(id, { ...jobs.get(id), ...OWNER_LEFT, status: 'failed', updated_at: now() });
        claims.delete(id);
      }
      for (const { video_id: id, pitch } of lane(sessionId).exports) {
        exports.set(exportKey(id, pitch), { ...exports.get(exportKey(id, pitch)), status: 'failed', error: OWNER_LEFT.error });
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
