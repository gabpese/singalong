import { Body, Controller, Get, Inject, Param, Post, Put, Query, Req, Res } from '@nestjs/common';
import type { Static } from '@sinclair/typebox';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { JobStore } from '../app.ts';
import { AgentService } from '../agents/agent.service.ts';
import type { SearchResult } from '../protocol.ts';
import { RateLimit } from '../rate-limit.guard.ts';
import { RoomService } from '../rooms/room.service.ts';
import { JOBS } from '../tokens.ts';
import { TypeBoxPipe } from '../validation.ts';
import { extractVideoId } from '../youtube.ts';
import { ExportBody, ExportQuery, LyricsBody, missingLyricsText, SearchQuery, SongBody, SongIdParams } from './song.schemas.ts';
import { SongService } from './song.service.ts';

const ROOM_HEADER = /^[A-Za-z0-9]{4,8}$/;
const LYRICS_TEXT_REQUIRED = { error: 'lyrics_text_required', message: 'Informe o texto da letra.' };
/** Why the lyrics could not be changed, as each refusal is answered. */
const LYRICS_REFUSALS = {
  not_found: [404, { error: 'not_found' }],
  imported: [409, { error: 'imported_lyrics', message: 'Música importada: para trocar a letra, importe o arquivo de novo escolhendo a letra.' }],
  in_progress: [409, { error: 'job_in_progress', message: 'A música ainda está sendo processada.' }],
} as const;

/** The song routes: the library, the preparation jobs and the YouTube search. */
@Controller('api')
export class SongsController {
  constructor(
    private readonly songs: SongService,
    @Inject(JOBS) private readonly jobs: JobStore,
    private readonly rooms: RoomService,
    private readonly agents: AgentService,
  ) {}

  /**
   * Where the request goes: the X-Room header says which Room it comes from. If the Room has a Session, its owner's agent
   * answers; with no header (or a Room without a Session), the classic worker. A Room that does not exist: 404.
   */
  private async sessionOf(request: FastifyRequest): Promise<string | null> {
    const code = String(request.headers['x-room'] ?? '');
    return ROOM_HEADER.test(code) ? this.rooms.sessionIdOf(code) : null;
  }

  /** Searches YouTube (the worker or the Session's agent answers); the chosen link then goes to POST /songs or to the queue. */
  @Get('search')
  @RateLimit('search', 'Muitas buscas seguidas. Espere alguns segundos e tente de novo.')
  async search(@Query(new TypeBoxPipe(SearchQuery)) { q }: Static<typeof SearchQuery>, @Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const sessionId = await this.sessionOf(request);
    if (sessionId && !(await this.agents.isOnline(sessionId))) {
      reply.code(503);
      return { error: 'owner_offline', message: 'O dono da sessão está desconectado. Cole o link do vídeo ou tente mais tarde.' };
    }
    try {
      const results: Omit<SearchResult, 'thumbnail'>[] = await this.jobs.search(q, { sessionId });
      return results.map((result): SearchResult => ({ ...result, thumbnail: `https://i.ytimg.com/vi/${result.video_id}/mqdefault.jpg` }));
    } catch (err) {
      request.log.warn({ err: (err as Error).message }, 'search failed');
      reply.code(503);
      return { error: 'search_unavailable', message: 'A busca não está disponível agora. Tente de novo ou cole o link do vídeo.' };
    }
  }

  /** The library: with the X-Room of a Room with local storage, the owner's catalog; otherwise, the server's. */
  @Get('songs')
  async list(@Req() request: FastifyRequest) {
    return this.songs.list({ sessionId: await this.sessionOf(request) });
  }

  /** Adds a link: it uses the cache when ready; otherwise it creates a job (or reuses the one under way). */
  @Post('songs')
  async request(@Body(new TypeBoxPipe(SongBody)) body: Static<typeof SongBody>, @Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const id = extractVideoId(body.url);
    if (!id) {
      reply.code(400);
      return { error: 'invalid_url', message: 'Link do YouTube inválido.' };
    }
    if (missingLyricsText(body.lyrics)) {
      reply.code(400);
      return LYRICS_TEXT_REQUIRED;
    }
    const result = await this.songs.request(id, body, { sessionId: await this.sessionOf(request) });
    if (result.error) { // an imported song's id never passes extractVideoId: this branch only keeps the types honest

      reply.code(404);
      return { error: 'song_not_found', message: 'Esta música importada não está na biblioteca do dono.' };
    }
    if (result.cached) {
      reply.code(200);
      return { ...result.song, cached: true };
    }
    reply.code(result.created ? 202 : 200);
    return { ...result.song, deduped: result.deduped };
  }

  @Get('songs/:id')
  async describe(@Param(new TypeBoxPipe(SongIdParams)) { id }: Static<typeof SongIdParams>, @Req() request: FastifyRequest, @Res({ passthrough: true }) reply: FastifyReply) {
    const song = await this.songs.describe(id, { sessionId: await this.sessionOf(request) });
    if (song) return song;
    reply.code(404);
    return { error: 'not_found' };
  }

  /** The karaoke MP4 (instrumental + lyrics) for offline use. POST asks for it (and returns its state); GET checks it. */
  @Post('songs/:id/export')
  @RateLimit('addToQueue')
  async requestExport(
    @Param(new TypeBoxPipe(SongIdParams)) { id }: Static<typeof SongIdParams>,
    @Body(new TypeBoxPipe(ExportBody)) body: Static<typeof ExportBody>,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.songs.requestExport(id, body.pitch ?? 0, { sessionId: await this.sessionOf(request) });
    if ('error' in result) {
      reply.code(result.error === 'not_found' ? 404 : 409);
      return result.error === 'not_found' ? { error: 'not_found' } : { error: 'not_ready', message: 'A música ainda está sendo preparada.' };
    }
    reply.code(result.export.status === 'ready' ? 200 : 202);
    return result.export;
  }

  @Get('songs/:id/export')
  async exportInfo(@Param(new TypeBoxPipe(SongIdParams)) { id }: Static<typeof SongIdParams>, @Query(new TypeBoxPipe(ExportQuery)) query: Static<typeof ExportQuery>, @Req() request: FastifyRequest) {
    return this.songs.exportInfo(id, query.pitch ?? 0, { sessionId: await this.sessionOf(request) });
  }

  /** Chooses or changes the lyrics' source (the cached instrumental is reused; only the lyrics are redone). */
  @Put('songs/:id/lyrics')
  async setLyrics(
    @Param(new TypeBoxPipe(SongIdParams)) { id }: Static<typeof SongIdParams>,
    @Body(new TypeBoxPipe(LyricsBody)) { artist, title, ...lyrics }: Static<typeof LyricsBody>,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    if (missingLyricsText(lyrics)) {
      reply.code(400);
      return LYRICS_TEXT_REQUIRED;
    }
    const result = await this.songs.setLyrics(id, lyrics, { artist, title }, { sessionId: await this.sessionOf(request) });
    if (result.error) {
      const [status, answer] = LYRICS_REFUSALS[result.error];
      reply.code(status);
      return answer;
    }
    reply.code(202);
    return result.song;
  }
}
