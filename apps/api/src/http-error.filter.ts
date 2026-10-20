import { type ArgumentsHost, Catch, type ExceptionFilter } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { HttpError } from './http-error.ts';

/** A request over a rate limit: 429 with Retry-After, the same answer the Fastify routes' rateLimited() gives. */
export class RateLimitError extends HttpError {
  constructor(readonly retryAfterSec: number, message: string) {
    super(429, 'rate_limited', message);
  }
}

/** Nest routes answer an HttpError exactly as the Fastify routes do: the status, with `{ error, message }`. */
@Catch(HttpError)
export class HttpErrorFilter implements ExceptionFilter {
  catch(error: HttpError, host: ArgumentsHost) {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    if (error instanceof RateLimitError) {
      reply.header('Retry-After', String(error.retryAfterSec));
      return reply.code(429).send({ error: 'rate_limited', message: error.message, retry_after: error.retryAfterSec });
    }
    return reply.code(error.status).send({ error: error.code, message: error.message });
  }
}
