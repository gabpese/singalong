import { applyDecorators, type CanActivate, type ExecutionContext, Inject, Injectable, SetMetadata, UseGuards } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { RateLimitError } from './http-error.filter.ts';
import type { LegacyServices } from './legacy.module.ts';
import { keyOf } from './rate-limit.js';
import { LIMITERS } from './tokens.ts';

const RATE_LIMIT = 'rateLimit';
const DEFAULT_MESSAGE = 'Muitas tentativas seguidas. Espere alguns segundos e tente de novo.';

interface RateLimitOptions {
  /** A limiter's name in rate-limit.js's DEFAULT_LIMITS (or the tests' config.rateLimits). */
  limiter: string;
  message?: string;
}

/**
 * Limits a route per person (the browser's id, or the IP), as the Fastify routes' rateLimited() does: over the limit, a 429
 * with Retry-After.
 */
export const RateLimit = (limiter: string, message?: string) =>
  applyDecorators(SetMetadata(RATE_LIMIT, { limiter, message } satisfies RateLimitOptions), UseGuards(RateLimitGuard));

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(LIMITERS) private readonly limiters: LegacyServices['limiters'],
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const options = this.reflector.get<RateLimitOptions | undefined>(RATE_LIMIT, context.getHandler());
    if (!options) return true;
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const call = this.limiters[options.limiter].hit(`${request.routeOptions?.url ?? request.url}|${keyOf(request)}`);
    if (!call.ok) throw new RateLimitError(call.retryAfterSec ?? 1, options.message ?? DEFAULT_MESSAGE);
    return true;
  }
}
