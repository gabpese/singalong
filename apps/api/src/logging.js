// Logs da API: o Fastify já escreve JSON (pino). Aqui só garantimos que nenhum segredo vai parar neles.

/** Troca o valor de ?host=<token> (token de anfitrião no endereço do WebSocket) por [oculto]. */
export function redactUrl(url) {
  return String(url ?? '').replace(/([?&](?:host|token)=)[^&#\s]*/gi, '$1[oculto]');
}

/** Opções do logger do Fastify: JSON, sem cabeçalhos (têm o token de anfitrião) e com o token fora da URL. */
export function buildLoggerOptions(level = 'info') {
  return {
    level,
    serializers: {
      req(request) {
        return { method: request.method, url: redactUrl(request.url), remoteAddress: request.ip };
      },
    },
  };
}
