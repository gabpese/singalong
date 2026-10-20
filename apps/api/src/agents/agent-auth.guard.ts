import { type CanActivate, createParamDecorator, type ExecutionContext, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Device } from '../database/entities.ts';
import { HttpError } from '../http-error.ts';
import { AgentService } from './agent.service.ts';

/** A request the guard let through: it carries the device that sent it. */
type AgentRequest = FastifyRequest & { device?: Device };

/** The device behind `Authorization: Bearer <device token>`; without a valid token, 401 (the app pairs again). */
export async function deviceOf(agents: AgentService, authorization: string | undefined): Promise<Device> {
  const header = String(authorization ?? '');
  const device = header.startsWith('Bearer ') ? await agents.authenticate(header.slice(7).trim()) : null;
  if (!device) throw new HttpError(401, 'unauthorized', 'Dispositivo não autorizado. Pareie de novo.');
  return device;
}

/** Requires the device token; the handler receives the device through @CurrentDevice(). */
@Injectable()
export class AgentAuthGuard implements CanActivate {
  constructor(private readonly agents: AgentService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AgentRequest>();
    request.device = await deviceOf(this.agents, request.headers.authorization);
    return true;
  }
}

/** The device AgentAuthGuard authenticated. */
export const CurrentDevice = createParamDecorator((_data: unknown, context: ExecutionContext) => context.switchToHttp().getRequest<AgentRequest>().device!);
