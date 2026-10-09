// Contrato de jobs entre a API (Node) e o worker (Python), sobre Redis.
//
//   stream  "jobs"        mensagens {video_id, payload}; payload = JSON {url, lyrics_source, lyrics_text?, artist?, title?}
//   group   "workers"     consumer group lido pelo worker (XREADGROUP); ack ao terminar
//   hash    "job:<id>"    estado: status (pending|processing|needs_lyrics|ready|failed), stage, error,
//                         lyrics_source, updated_at. A API cria como "pending"; o worker atualiza o resto.
//
// Exportação em MP4 (karaokê offline; também atendida por uma thread própria do worker):
//   lista  "export:req"            a API faz LPUSH de {video_id, pitch}
//   hash   "export:<id>:<pitch>"   o worker grava status (processing | ready | failed) e error; a API cria como "pending"
//
// A API nunca chama o worker; o worker sempre puxa trabalho (funciona atrás de NAT, ex.: GPU remota).

//
// Busca no YouTube (a API não tem yt-dlp; quem busca é o worker, numa thread própria):
//   lista  "search:req"        a API faz LPUSH de {id, q}
//   lista  "search:res:<id>"   o worker responde com LPUSH de {results:[{video_id,title,channel,duration}]} ou {error}
//   chave  "search:cache:<hash>" cache dos resultados na API (10 min), para não martelar o YouTube

import { createHash, randomUUID } from 'node:crypto';

export const STREAM = 'jobs';
const SEARCH_CACHE_TTL = 600;
export const GROUP = 'workers';
const jobKey = (id) => `job:${id}`;

const ENQUEUE = `
local status = redis.call('HGET', KEYS[1], 'status')
if status == 'pending' or status == 'processing' then return 0 end
if status == 'needs_lyrics' and ARGV[1] == '0' then return 0 end
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1], 'status', 'pending', 'stage', '', 'error', '', 'lyrics_source', ARGV[3], 'updated_at', ARGV[2])
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

/** Enfileira de forma atômica: devolve {created:false} se já há job pendente/em processamento (dedupe). */
export function createRedisJobStore(redis) {
  redis.defineCommand('enqueueJob', { numberOfKeys: 2, lua: ENQUEUE });
  redis.defineCommand('requestExport', { numberOfKeys: 2, lua: REQUEST_EXPORT });
  return {
    async get(id) {
      return toJob(await redis.hgetall(jobKey(id)));
    },
    async enqueue(id, payload, { replace = false } = {}) {
      const created = await redis.enqueueJob(
        jobKey(id), STREAM, replace ? '1' : '0', String(Date.now()), payload.lyrics_source ?? 'auto', JSON.stringify(payload), id,
      );
      return { created: created === 1, job: toJob(await redis.hgetall(jobKey(id))) };
    },
    async requestExport(id, pitch) {
      await redis.requestExport(exportKey(id, pitch), 'export:req', String(Date.now()), JSON.stringify({ video_id: id, pitch }));
      return toExport(await redis.hgetall(exportKey(id, pitch)));
    },
    async exportState(id, pitch) {
      return toExport(await redis.hgetall(exportKey(id, pitch)));
    },
    async search(query, { timeoutSec = 20 } = {}) {
      const q = query.trim();
      const cacheKey = `search:cache:${createHash('sha1').update(q.toLowerCase()).digest('hex')}`;
      const cached = await redis.get(cacheKey);
      if (cached) return JSON.parse(cached);

      const id = randomUUID();
      const request = JSON.stringify({ id, q });
      await redis.lpush('search:req', request);
      const blocking = redis.duplicate(); // BRPOP bloqueia a conexão: não pode ser a compartilhada
      let reply;
      try {
        reply = await blocking.brpop(`search:res:${id}`, timeoutSec);
      } finally {
        blocking.disconnect();
      }
      if (!reply) {
        await redis.lrem('search:req', 0, request); // ninguém atendeu: tira o pedido da fila
        throw new Error('search_timeout');
      }
      const { results, error } = JSON.parse(reply[1]);
      if (error) throw new Error(error);
      await redis.set(cacheKey, JSON.stringify(results), 'EX', SEARCH_CACHE_TTL);
      return results;
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
export function createMemoryJobStore() {
  const jobs = new Map();
  const queue = [];
  const exports = new Map();
  return {
    queue,
    exportQueue: [],
    /** Resultados que a busca devolve (ou um Error para simular falha) e as consultas recebidas. */
    searchResults: [],
    searchQueries: [],
    async search(query) {
      this.searchQueries.push(query.trim());
      if (this.searchResults instanceof Error) throw this.searchResults;
      return this.searchResults;
    },
    async get(id) {
      return jobs.get(id) ? { ...jobs.get(id) } : null;
    },
    async enqueue(id, payload, { replace = false } = {}) {
      const current = jobs.get(id);
      const busy = current && (current.status === 'pending' || current.status === 'processing');
      if (busy || (current?.status === 'needs_lyrics' && !replace)) return { created: false, job: { ...current } };
      const job = { status: 'pending', stage: null, error: null, error_code: null, retry: null, lyrics_source: payload.lyrics_source ?? 'auto', updated_at: Date.now() };
      jobs.set(id, job);
      queue.push({ video_id: id, payload });
      return { created: true, job: { ...job } };
    },
    async requestExport(id, pitch) {
      const key = exportKey(id, pitch);
      if (!['pending', 'processing'].includes(exports.get(key)?.status)) {
        exports.set(key, { status: 'pending', error: null });
        this.exportQueue.push({ video_id: id, pitch });
      }
      return { ...exports.get(key) };
    },
    async exportState(id, pitch) {
      return exports.get(exportKey(id, pitch)) ? { ...exports.get(exportKey(id, pitch)) } : null;
    },
    /** Simula o worker atualizando o estado de uma exportação. */
    updateExport(id, pitch, fields) {
      exports.set(exportKey(id, pitch), { ...exports.get(exportKey(id, pitch)), ...fields });
    },
    /** Simula o worker atualizando o estado. */
    update(id, fields) {
      jobs.set(id, { ...jobs.get(id), ...fields, updated_at: Date.now() });
    },
    async ping() {
      return true;
    },
    async close() {},
  };
}
