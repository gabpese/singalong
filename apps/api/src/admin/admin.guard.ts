import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { safeEqual } from '../agents/agents.ts';
import type { AppConfig } from '../app.ts';
import { RateLimitError } from '../http-error.filter.ts';
import type { LegacyServices } from '../legacy.module.ts';
import { keyOf } from '../rate-limit.js';
import { HttpError } from '../rooms.js';
import { CONFIG, LIMITERS } from '../tokens.ts';

/**
 * Every call to the admin API needs the ADMIN_TOKEN in the `X-Admin-Token` header. Calls are limited per person, and a wrong
 * token spends a small quota per IP: past it, 429 (it guards against guessing the token).
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    @Inject(LIMITERS) private readonly limiters: LegacyServices['limiters'],
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const call = this.limiters.admin.hit(`${request.routeOptions?.url ?? request.url}|${keyOf(request)}`);
    if (!call.ok) throw new RateLimitError(call.retryAfterSec ?? 1, 'Muitas tentativas seguidas. Espere alguns segundos e tente de novo.');
    if (!safeEqual(request.headers['x-admin-token'], this.config.adminToken)) {
      const attempt = this.limiters.adminFail.hit(`bad|${request.ip}`);
      if (!attempt.ok) throw new HttpError(429, 'rate_limited', 'Muitas tentativas erradas. Espere alguns minutos.');
      throw new HttpError(403, 'forbidden', 'Token de administrador inválido.');
    }
    return true;
  }
}
