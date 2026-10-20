import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import type { Static } from '@sinclair/typebox';
import type { FastifyReply } from 'fastify';
import type { JobStore } from '../app.ts';
import type { Device, Session } from '../database/entities.ts';
import { RateLimit } from '../rate-limit.guard.ts';
import { ReleaseService } from '../release/release.service.ts';
import { HttpError } from '../http-error.ts';
import type { LocalStorage } from '../storage.ts';
import { RoomService } from '../rooms/room.service.ts';
import { JOBS, STORAGE } from '../tokens.ts';
import { TypeBoxPipe } from '../validation.ts';
import { updateInfo } from '../version.ts';
import { AgentAuthGuard, CurrentDevice } from './agent-auth.guard.ts';
import {
  CloudMissingBody,
  ExportParams,
  ExportStateBody,
  HeartbeatBody,
  JobCompleteBody,
  JobParams,
  JobProgressBody,
  LibraryBody,
  SearchParams,
  SearchResultBody,
  SessionBody,
  StatsQuery,
  VideoIdParams,
  WaitBody,
} from './agent.schemas.ts';
import { AgentService } from './agent.service.ts';
import { CLOUD_REQUIRED, requireCloud } from './cloud.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const notYourJob = () => new HttpError(409, 'not_your_job', 'Este job não está com este agente.');

/**
 * The agent API (/agent/v1) for a paired computer, which sends `Authorization: Bearer <device token>`. The agent only makes
 * OUTBOUND connections: it starts a Session, creates its Rooms and keeps claiming work (long poll). Only the agent that owns a
 * Room's Session gets that Room's requests. The cloud file upload is a Fastify route (cloud.ts).
 */
@Controller('agent/v1')
@UseGuards(AgentAuthGuard)
export class AgentController {
  /** Each device's version, from its last heartbeat (only in memory: the agent sends it again when it opens). */
  private readonly reportedVersion = new Map<string, string>();

  constructor(
    private readonly agents: AgentService,
    private readonly release: ReleaseService,
    @Inject(JOBS) private readonly jobs: JobStore,
    private readonly rooms: RoomService,
    @Inject(STORAGE) private readonly storage: LocalStorage,
  ) {}

  /** The device's active Session, which also counts as a sign of life; 426 for an app too old, 409 before a Session starts. */
  private async workingSession(device: Device): Promise<Session> {
    if (updateInfo(this.reportedVersion.get(device.id), this.release.get()).status === 'update_required') {
      throw new HttpError(426, 'update_required', 'Esta versão do aplicativo é antiga demais. Atualize para continuar.');
    }
    const session = await this.agents.touch(device);
    if (!session) throw new HttpError(409, 'no_active_session', 'Inicie uma sessão antes de pedir trabalho.');
    return session;
  }

  // --- the device and its Session ---

  @Get('me')
  async me(@CurrentDevice() device: Device) {
    const session = await this.agents.activeSession(device);
    return {
      cloud: await this.agents.canUploadToCloud(device), // does this computer send its songs to the cloud?
      device: { id: device.id, name: device.name },
      session: session ? { id: session.id, display_name: session.displayName } : null,
    };
  }

  /** The owner's statistics: what played in the Rooms of this computer's Sessions over the last `days` days (1 to 365). */
  @Get('stats')
  async stats(@CurrentDevice() device: Device, @Query(new TypeBoxPipe(StatsQuery)) query: Static<typeof StatsQuery>) {
    const days = query.days ?? 30;
    const since = Date.now() - days * DAY_MS;
    return { days, since, ...(await this.rooms.statsFor(device.id, since)) };
  }

  @Delete('devices/me')
  @HttpCode(204)
  async revoke(@CurrentDevice() device: Device) {
    await this.agents.revoke(device);
  }

  @Post('sessions')
  async startSession(@CurrentDevice() device: Device, @Body(new TypeBoxPipe(SessionBody)) body: Static<typeof SessionBody>) {
    const session = await this.agents.startSession(device, body.display_name, { resumeId: body.resume_id, mediaBase: body.media_base });
    return { id: session.id, display_name: session.displayName };
  }

  @Delete('sessions/:id')
  @HttpCode(204)
  async endSession(@CurrentDevice() device: Device, @Param('id') id: string) {
    await this.agents.endSession(await this.agents.ownSession(device, id));
  }

  /** The owner creates their Session's Rooms (the browser opens the page as the Host, with the host_token). */
  @Post('sessions/:id/rooms')
  @RateLimit('createRoom')
  async createRoom(@CurrentDevice() device: Device, @Param('id') id: string) {
    const session = await this.agents.ownSession(device, id);
    if (session.endedAt) throw new HttpError(409, 'session_ended', 'A sessão já terminou.');
    return { ...(await this.rooms.createRoom({ sessionId: session.id })), session_id: session.id };
  }

  @Post('heartbeat')
  @HttpCode(200)
  async heartbeat(@CurrentDevice() device: Device, @Body(new TypeBoxPipe(HeartbeatBody)) body: Static<typeof HeartbeatBody>) {
    if (body.version) {
      this.reportedVersion.set(device.id, body.version);
      await this.agents.recordVersion(device, body.version);
    }
    const session = await this.agents.touch(device);
    if (session && body.media_base !== undefined) await this.agents.setMediaBase(session, body.media_base);
    return { ok: true, session_id: session?.id ?? null, server_time: Date.now(), update: updateInfo(body.version, this.release.get()) };
  }

  // --- the cloud ---

  /** Which of these songs the cloud does not have yet (the agent sends only what is missing). */
  @Post('cloud/missing')
  @HttpCode(200)
  async cloudMissing(@CurrentDevice() device: Device, @Body(new TypeBoxPipe(CloudMissingBody)) { ids }: Static<typeof CloudMissingBody>) {
    await requireCloud(this.agents, this.storage, device);
    const missing: string[] = [];
    for (const id of ids) {
      if (await this.agents.isSongBlocked(id)) continue; // the administrator took this song off the cloud: do not ask again
      const found = await Promise.all(CLOUD_REQUIRED.map((file) => this.storage.exists(`cache/${id}/${file}`)));
      if (!found.every(Boolean)) missing.push(id);
    }
    return { missing };
  }

  // --- the local catalog: the songs on the owner's computer ---

  /** The agent publishes what it has (when it starts, and for each new song, backing vocals or MP4). Only meta.json and which files exist. */
  @Put('library')
  async publishLibrary(@CurrentDevice() device: Device, @Body(new TypeBoxPipe(LibraryBody)) { songs }: Static<typeof LibraryBody>) {
    await this.agents.touch(device);
    return { count: await this.agents.publishLibrary(device, songs) };
  }

  @Delete('library/:id')
  @HttpCode(204)
  async unpublish(@CurrentDevice() device: Device, @Param(new TypeBoxPipe(VideoIdParams)) { id }: Static<typeof VideoIdParams>) {
    if (!(await this.agents.unpublish(device, id))) throw new HttpError(404, 'not_found', 'Esta música não está no catálogo.');
  }

  // --- preparation jobs ---

  @Post('jobs/claim')
  @HttpCode(200)
  async claimJob(@CurrentDevice() device: Device, @Body(new TypeBoxPipe(WaitBody)) { wait_ms }: Static<typeof WaitBody>, @Res({ passthrough: true }) reply: FastifyReply) {
    const session = await this.workingSession(device);
    const job = await this.jobs.claim(session.id, device.id, { waitMs: wait_ms ?? 0 });
    await this.agents.touch(device); // the wait may have lasted up to 25 s: it renews the sign of life
    if (job) return { job };
    reply.code(204);
  }

  @Post('jobs/:id/progress')
  @HttpCode(204)
  async jobProgress(@CurrentDevice() device: Device, @Param(new TypeBoxPipe(JobParams)) { id }: Static<typeof JobParams>, @Body(new TypeBoxPipe(JobProgressBody)) body: Static<typeof JobProgressBody>) {
    await this.agents.touch(device);
    if (!(await this.jobs.progress(id, device.id, body))) throw notYourJob();
  }

  @Post('jobs/:id/complete')
  @HttpCode(204)
  async completeJob(@CurrentDevice() device: Device, @Param(new TypeBoxPipe(JobParams)) { id }: Static<typeof JobParams>, @Body(new TypeBoxPipe(JobCompleteBody)) body: Static<typeof JobCompleteBody>) {
    await this.agents.touch(device);
    const { status, ...fields } = body;
    if (!(await this.jobs.complete(id, device.id, status, fields))) throw notYourJob();
  }

  // --- YouTube search ---

  @Post('search/claim')
  @HttpCode(200)
  async claimSearch(@CurrentDevice() device: Device, @Body(new TypeBoxPipe(WaitBody)) { wait_ms }: Static<typeof WaitBody>, @Res({ passthrough: true }) reply: FastifyReply) {
    const session = await this.workingSession(device);
    const found = await this.jobs.claimSearch(session.id, { waitMs: wait_ms ?? 0 });
    await this.agents.touch(device);
    if (found) return { request: found };
    reply.code(204);
  }

  @Post('search/:id/result')
  @HttpCode(204)
  async searchResult(@CurrentDevice() device: Device, @Param(new TypeBoxPipe(SearchParams)) { id }: Static<typeof SearchParams>, @Body(new TypeBoxPipe(SearchResultBody)) body: Static<typeof SearchResultBody>) {
    const session = await this.workingSession(device);
    if (!(await this.jobs.replySearch(session.id, id, body))) throw new HttpError(409, 'unknown_search', 'Esta busca não é desta sessão ou já venceu.');
  }

  // --- MP4 export ---

  @Post('exports/claim')
  @HttpCode(200)
  async claimExport(@CurrentDevice() device: Device, @Body(new TypeBoxPipe(WaitBody)) { wait_ms }: Static<typeof WaitBody>, @Res({ passthrough: true }) reply: FastifyReply) {
    const session = await this.workingSession(device);
    const found = await this.jobs.claimExport(session.id, { waitMs: wait_ms ?? 0 });
    await this.agents.touch(device);
    if (found) return { request: found };
    reply.code(204);
  }

  @Post('exports/:id/:pitch/state')
  @HttpCode(204)
  async exportState(@CurrentDevice() device: Device, @Param(new TypeBoxPipe(ExportParams)) { id, pitch }: Static<typeof ExportParams>, @Body(new TypeBoxPipe(ExportStateBody)) body: Static<typeof ExportStateBody>) {
    const session = await this.workingSession(device);
    if (!(await this.jobs.setExportState(session.id, id, pitch, body.status, body.error))) {
      throw new HttpError(409, 'unknown_export', 'Esta exportação não é desta sessão.');
    }
  }
}
