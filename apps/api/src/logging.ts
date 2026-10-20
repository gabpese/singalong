// The API's logs: Fastify already writes JSON (pino). This only makes sure no secret ends up in them.
import type { FastifyRequest, FastifyServerOptions } from 'fastify';

/** Replaces the value of ?host=<token> (the Host's token in an address) or ?token= with [oculto]. */
export function redactUrl(url: unknown): string {
  return String(url ?? '').replace(/([?&](?:host|token)=)[^&#\s]*/gi, '$1[oculto]');
}

/** Fastify's logger options: JSON, without the headers (they carry the Host's token) and with the token out of the URL. */
export function buildLoggerOptions(level = 'info'): FastifyServerOptions['logger'] {
  return {
    level,
    serializers: {
      req(request: FastifyRequest) {
        return { method: request.method, url: redactUrl(request.url), remoteAddress: request.ip };
      },
    },
  };
}
