import { Body, Controller, Get, Headers, HttpCode, Inject, Post, Query, Req, Res } from '@nestjs/common';
import type { Static } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../app.ts';
import type { LegacyServices } from '../legacy.module.ts';
import { pairingEmail } from '../mailer.js';
import { RateLimit } from '../rate-limit.guard.ts';
import { ReleaseService } from '../release/release.service.ts';
import { HttpError } from '../rooms.js';
import { CONFIG, LIMITERS, MAILER } from '../tokens.ts';
import { TypeBoxPipe } from '../validation.ts';
import { updateInfo } from '../version.js';
import { PairCompleteBody, PairRequestBody, PairStartBody, VersionQuery } from './agent.schemas.ts';
import { AgentService } from './agent.service.ts';
import { safeEqual } from './agents.ts';

const EMAIL_SHAPE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

/** The agent API's open routes (/agent/v1): the published version and pairing, before the computer has a token. */
@Controller('agent/v1')
export class PairingController {
  constructor(
    private readonly agents: AgentService,
    private readonly release: ReleaseService,
    @Inject(CONFIG) private readonly config: AppConfig,
    @Inject(LIMITERS) private readonly limiters: LegacyServices['limiters'],
    @Inject(MAILER) private readonly mailer: LegacyServices['mailer'],
  ) {}

  /** What the app at version `current` should do: the version published on the admin page or, without it, by the APP_* variables. */
  @Get('version')
  version(@Query(new TypeBoxPipe(VersionQuery)) { current }: Static<typeof VersionQuery>) {
    return updateInfo(current, this.release.get());
  }

  /** A code made by the server's administrator (ADMIN_TOKEN). Without that secret configured, pairing this way is off. */
  @Post('pair/start')
  @RateLimit('pair')
  async start(
    @Body(new TypeBoxPipe(PairStartBody)) { email }: Static<typeof PairStartBody>,
    @Headers('x-admin-token') adminToken: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    if (!this.config.adminToken) {
      reply.code(404);
      return { error: 'not_found' };
    }
    if (!safeEqual(adminToken, this.config.adminToken)) throw new HttpError(403, 'forbidden', 'Token de administrador inválido.');
    return this.agents.startPairing(email ? email.trim().toLowerCase() : null);
  }

  /**
   * The person asks for the code with their e-mail: it is sent only to an address the administrator authorized. The answer is
   * the same for any e-mail, so nobody learns who is on the list, and the e-mail goes out in the background.
   */
  @Post('pair/request')
  @HttpCode(202)
  @RateLimit('pairRequest', undefined, 'ip')
  async request(@Body(new TypeBoxPipe(PairRequestBody)) body: Static<typeof PairRequestBody>, @Req() request: FastifyRequest) {
    if (!this.mailer.enabled || !(await this.agents.hasPairRules(this.config.pairAllowedEmails))) {
      throw new HttpError(503, 'email_disabled', 'Este servidor não envia códigos por e-mail. Peça o código a quem administra o servidor.');
    }
    const email = body.email.trim().toLowerCase();
    if (!EMAIL_SHAPE.test(email)) throw new HttpError(400, 'bad_email', 'Digite um e-mail válido.');
    const limited = this.limiters.pairEmail.hit(email);
    // an asterisk on the list = any e-mail may ask (the limits per IP and per address still hold)
    if (limited.ok && (await this.agents.canPairByEmail(email, this.config.pairAllowedEmails))) {
      const { code, expires_in: seconds } = await this.agents.startPairing(email); // the computer paired with this code is tied to this e-mail
      const message = pairingEmail({ code, minutes: Math.round(seconds / 60), server: this.config.publicUrl || '' });
      this.mailer.send({ to: email, ...message }).catch((error: Error) => request.log.error({ err: error.message }, 'could not send the pairing code'));
    }
    return { ok: true, message: 'Se este e-mail estiver autorizado, o código chega em instantes. Olhe também a caixa de spam.' };
  }

  @Post('pair/complete')
  @RateLimit('pair')
  complete(@Body(new TypeBoxPipe(PairCompleteBody)) { code, name }: Static<typeof PairCompleteBody>) {
    return this.agents.completePairing(code, name);
  }
}
