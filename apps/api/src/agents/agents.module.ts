import { Module } from '@nestjs/common';
import { ReleaseModule } from '../release/release.module.ts';
import { AgentController } from './agent.controller.ts';
import { PairingController } from './pairing.controller.ts';

/**
 * The agent API (/agent/v1). The AgentService itself comes from app.ts (the Rooms and the songs use it too) through
 * LegacyModule; the cloud file upload stays a Fastify route (cloud.ts).
 */
@Module({ imports: [ReleaseModule], controllers: [PairingController, AgentController] })
export class AgentsModule {}
