import { Body, Controller, createParamDecorator, Delete, type ExecutionContext, Get, HttpCode, Param, Patch, Post, Put } from '@nestjs/common';
import type { Static } from '@sinclair/typebox';
import type { FastifyRequest } from 'fastify';
import { HttpError } from '../http-error.ts';
import { RateLimit } from '../rate-limit.guard.ts';
import { TypeBoxPipe } from '../validation.ts';
import {
  AddBody,
  InviteBody,
  ItemParams,
  ItemSettingsBody,
  MoveBody,
  OffsetBody,
  PartsBody,
  PlayerParams,
  RespondBody,
  RoomParams,
  SeekBody,
  SettingsBody,
  SongParams,
} from './room.schemas.ts';
import { RoomService } from './room.service.ts';
import { type Actor, CLIENT_ID } from './rooms.ts';

/**
 * Who sends the request: the browser's id (X-Client-Id) and, for the Host, the Room's token (X-Host-Token). Without a valid
 * id, 400, unless the route takes anyone (`{ optional: true }`).
 */
const CurrentActor = createParamDecorator((options: { optional?: boolean } | undefined, context: ExecutionContext): Actor => {
  const request = context.switchToHttp().getRequest<FastifyRequest>();
  const clientId = String(request.headers['x-client-id'] ?? '');
  if (!CLIENT_ID.test(clientId) && !options?.optional) throw new HttpError(400, 'client_id_required', 'Identificação do navegador ausente.');
  return { clientId: CLIENT_ID.test(clientId) ? clientId : '', hostToken: String(request.headers['x-host-token'] ?? '') };
});

const room = new TypeBoxPipe(RoomParams);
const item = new TypeBoxPipe(ItemParams);
const song = new TypeBoxPipe(SongParams);

/** The Rooms, the Queue and the playback controls. Each change answers with the asker's new state; the WebSocket gets it too. */
@Controller('api/rooms')
export class RoomsController {
  constructor(private readonly rooms: RoomService) {}

  @Post()
  @RateLimit('createRoom', 'Muitas salas criadas seguidas. Espere um pouco.')
  create() {
    return this.rooms.createRoom();
  }

  @Get(':code')
  state(@Param(room) { code }: Static<typeof RoomParams>, @CurrentActor({ optional: true }) actor: Actor) {
    return this.rooms.getState(code, actor);
  }

  @Patch(':code')
  async settings(@Param(room) { code }: Static<typeof RoomParams>, @Body(new TypeBoxPipe(SettingsBody)) body: Static<typeof SettingsBody>, @CurrentActor() actor: Actor) {
    return (await this.rooms.setSettings(code, body, actor)).state;
  }

  @Post(':code/queue')
  @RateLimit('addToQueue')
  add(@Param(room) { code }: Static<typeof RoomParams>, @Body(new TypeBoxPipe(AddBody)) body: Static<typeof AddBody>, @CurrentActor() actor: Actor) {
    return this.rooms.add(code, body, actor);
  }

  @Delete(':code/queue/:itemId')
  async remove(@Param(item) { code, itemId }: Static<typeof ItemParams>, @CurrentActor() actor: Actor) {
    return (await this.rooms.remove(code, itemId, actor)).state;
  }

  @Post(':code/queue/:itemId/move')
  @HttpCode(200)
  async move(@Param(item) { code, itemId }: Static<typeof ItemParams>, @Body(new TypeBoxPipe(MoveBody)) { direction }: Static<typeof MoveBody>, @CurrentActor() actor: Actor) {
    return (await this.rooms.move(code, itemId, direction, actor)).state;
  }

  // Duet: invite someone in the Room, take the invitation back, and answer it
  @Post(':code/queue/:itemId/invite')
  @HttpCode(200)
  async invite(@Param(item) { code, itemId }: Static<typeof ItemParams>, @Body(new TypeBoxPipe(InviteBody)) { pid }: Static<typeof InviteBody>, @CurrentActor() actor: Actor) {
    return (await this.rooms.invite(code, itemId, pid, actor)).state;
  }

  @Delete(':code/queue/:itemId/invite')
  async cancelInvite(@Param(item) { code, itemId }: Static<typeof ItemParams>, @CurrentActor() actor: Actor) {
    return (await this.rooms.cancelInvite(code, itemId, actor)).state;
  }

  @Post(':code/queue/:itemId/invite/respond')
  @HttpCode(200)
  async respondInvite(@Param(item) { code, itemId }: Static<typeof ItemParams>, @Body(new TypeBoxPipe(RespondBody)) { accept }: Static<typeof RespondBody>, @CurrentActor() actor: Actor) {
    return (await this.rooms.respondInvite(code, itemId, accept, actor)).state;
  }

  @Patch(':code/queue/:itemId')
  async itemSettings(@Param(item) { code, itemId }: Static<typeof ItemParams>, @Body(new TypeBoxPipe(ItemSettingsBody)) body: Static<typeof ItemSettingsBody>, @CurrentActor() actor: Actor) {
    return (await this.rooms.setItemSettings(code, itemId, body, actor)).state;
  }

  @Post(':code/player/seek')
  @HttpCode(200)
  async seek(@Param(room) { code }: Static<typeof RoomParams>, @Body(new TypeBoxPipe(SeekBody)) body: Static<typeof SeekBody>, @CurrentActor() actor: Actor) {
    return (await this.rooms.seek(code, body, actor)).state;
  }

  /**
   * pause, resume, skip and start. `start` skips the Intermission (the applause and the walk to the stage): the next song
   * starts now. `skip` may name the song on the Host's screen ({ item_id }): one that already ended is not skipped again.
   */
  @Post(':code/player/:action')
  @HttpCode(200)
  async player(@Param(new TypeBoxPipe(PlayerParams)) { code, action }: Static<typeof PlayerParams>, @Body() body: { item_id?: unknown } | undefined, @CurrentActor() actor: Actor) {
    const result = action === 'skip' ? await this.rooms.skip(code, actor, Number.isInteger(body?.item_id) ? (body!.item_id as number) : null)
      : action === 'start' ? await this.rooms.startNow(code, actor)
      : await this.rooms.setPlayback(code, action === 'resume', actor);
    return result.state;
  }

  @Put(':code/songs/:videoId/offset')
  async offset(@Param(song) { code, videoId }: Static<typeof SongParams>, @Body(new TypeBoxPipe(OffsetBody)) { offset }: Static<typeof OffsetBody>, @CurrentActor() actor: Actor) {
    return (await this.rooms.setOffset(code, videoId, offset, actor)).state;
  }

  @Put(':code/songs/:videoId/parts')
  async parts(@Param(song) { code, videoId }: Static<typeof SongParams>, @Body(new TypeBoxPipe(PartsBody)) { parts }: Static<typeof PartsBody>, @CurrentActor() actor: Actor) {
    return (await this.rooms.setParts(code, videoId, parts, actor)).state;
  }
}
