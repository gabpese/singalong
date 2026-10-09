// Limite de requisições por pessoa (janela fixa, em memória): protege a pesquisa no YouTube (que o YouTube pode barrar
// com captcha se for martelada) e a criação de salas/pedidos contra abuso ou um botão apertado sem parar.

/**
 * @param max       quantos pedidos cabem em cada janela
 * @param windowMs  duração da janela
 */
export function createRateLimiter({ max, windowMs, now = Date.now }) {
  const buckets = new Map(); // chave -> { count, resetAt }
  let lastSweep = now();

  return {
    /** Registra um pedido. { ok: false, retryAfterSec } quando passou do limite. */
    hit(key) {
      const t = now();
      if (t - lastSweep > windowMs) {
        for (const [k, b] of buckets) if (b.resetAt <= t) buckets.delete(k); // não deixa o mapa crescer para sempre
        lastSweep = t;
      }
      let bucket = buckets.get(key);
      if (!bucket || bucket.resetAt <= t) {
        bucket = { count: 0, resetAt: t + windowMs };
        buckets.set(key, bucket);
      }
      bucket.count++;
      return bucket.count <= max ? { ok: true } : { ok: false, retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - t) / 1000)) };
    },
    get size() {
      return buckets.size;
    },
  };
}

/** Quem é "a pessoa": o id do navegador; sem ele, o IP. */
export const keyOf = (request) => String(request.headers['x-client-id'] || request.ip);

/** preHandler do Fastify: responde 429 (com Retry-After) quando a pessoa passou do limite. */
export function rateLimited(limiter, { message = 'Muitas tentativas seguidas. Espere alguns segundos e tente de novo.' } = {}) {
  return async function rateLimitHook(request, reply) {
    const result = limiter.hit(`${request.routeOptions?.url ?? request.url}|${keyOf(request)}`);
    if (!result.ok) {
      reply.header('Retry-After', String(result.retryAfterSec));
      return reply.code(429).send({ error: 'rate_limited', message, retry_after: result.retryAfterSec });
    }
    return undefined;
  };
}

/** Limites padrão por pessoa e por minuto (sobrescrevíveis em config.rateLimits, p.ex. nos testes). */
export const DEFAULT_LIMITS = {
  search: { max: 12, windowMs: 60_000 }, // cada busca vira uma consulta ao YouTube
  addToQueue: { max: 30, windowMs: 60_000 },
  createRoom: { max: 10, windowMs: 60_000 },
};
