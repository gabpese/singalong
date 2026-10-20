import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { type MikroORM, UniqueConstraintViolationException } from '@mikro-orm/core';
import type { AgentService } from '../agents/agent.service.ts';
import { PlayLog, QueueItem, Room, Session, SongSettings } from '../database/entities.ts';
import { HttpError } from '../http-error.ts';
import type { AddedSong, CreatedRoom, Guest, Interlude, LyricCue, Playback, SongKey } from '../protocol.ts';
import { createSerializer } from '../serial.ts';
import type { LyricsChoice, SongService } from '../songs/song.service.ts';
import { extractVideoId } from '../youtube.ts';
import { type Connection, Hub, type RoomSocket } from './hub.ts';
import { clampBacking, clampGuide, clampOffset, clampPitch, cleanParts, nextPlayable, playOrder, swapTarget } from './queue-logic.ts';
import { createBucket, REACTION_KINDS } from './reactions.ts';
import { type Actor, type BaseRoomState, cleanName, generateCode, MAX_PER_CLIENT, MAX_QUEUE, normalizeCode, personalize, pidOf, sanitizeCues } from './rooms.ts';

const ROOM_TTL_MS = 24 * 60 * 60 * 1000;
const PLAY_LOG_TTL_MS = 400 * 24 * 60 * 60 * 1000; // the play history stays for over a year
const TOUCH_EVERY_MS = 60_000;

/** The Intermission between songs: how long the applause and the walk to the stage last (0 turns a phase off), and whether a new Room has it on. */
export interface IntermissionOptions {
  applauseMs: number;
  stageMs: number;
  byDefault: boolean;
}

export interface RoomServiceOptions {
  orm: MikroORM;
  /** What the Rooms need of the songs: whether one is ready, its state, and asking for it. */
  songs: Pick<SongService, 'isReady' | 'describe' | 'request'>;
  hub?: Hub;
  /** The local agents: the nickname and the state (online) of a Room's Session owner. */
  agents?: AgentService | null;
  intermission?: IntermissionOptions;
  now?: () => number;
  newCode?: () => string;
  newToken?: () => string;
}

/** A song added to the Queue (the queue route's body). */
export interface AddParams {
  url?: string;
  video_id?: string;
  lyrics?: LyricsChoice;
  artist?: string;
  title?: string;
  display_title?: string;
  name?: string;
  pitch?: number;
}

/** The Room's settings, the Host's alone. */
export interface RoomSettings {
  fair?: boolean;
  scoring?: boolean;
  voice?: boolean;
  voice_volume?: number;
  melody_bars?: boolean;
  intermission?: boolean;
}

type QueueStatus = 'queued' | 'playing' | 'done' | 'skipped';

/** Duet: the guest and whether they accepted, as the pages see them; null without one. */
const guestOf = (item: QueueItem): Guest | null => (item.guestStatus ? { name: item.guestName ?? '', status: item.guestStatus as Guest['status'] } : null);

/**
 * The Rooms and their Queue, on MikroORM. Every command that reads and then changes a Room runs alone, in the order it arrived
 * (a first-in-first-out queue per Room). Each read uses a fresh EntityManager, so it always sees what the last write left.
 *
 * Inside a transaction nothing waits on another service: all of them share the one SQLite connection, which the transaction
 * holds until it ends, so such a wait would never end.
 */
export class RoomService {
  readonly hub: Hub;
  private readonly orm: MikroORM;
  private readonly songs: RoomServiceOptions['songs'];
  private readonly agents: AgentService | null;
  private readonly intermission: IntermissionOptions;
  private readonly now: () => number;
  private readonly newCode: () => string;
  private readonly newToken: () => string;

  private readonly positions = new Map<string, { item_id: number; ms: number }>(); // fleeting: only the TV knows, and reports every few seconds
  private readonly lyricsCache = new Map<string, { item_id: number; cues: LyricCue[] }>(); // the lyrics of the song playing, which the TV sent for the Stage
  private readonly lastKeys = new Map<string, string>(); // the last state broadcast (without the position)
  private readonly touched = new Map<string, number>(); // the last time last_active_at was written
  private timers: NodeJS.Timeout[] = [];
  private readonly wakes = new Set<NodeJS.Timeout>(); // the Intermission's alarms (one per end of phase)

  /** Serializes a Room's operations: every command that reads and then changes a Room runs alone, in the order it arrived. */
  private readonly withLock = createSerializer();

  constructor({
    orm,
    songs,
    hub = new Hub(),
    agents = null,
    // with no durations (the API tests) there is no Intermission: the next song starts at once
    intermission = { applauseMs: 0, stageMs: 0, byDefault: true },
    now = Date.now,
    newCode = generateCode,
    newToken = () => randomBytes(16).toString('hex'),
  }: RoomServiceOptions) {
    this.orm = orm;
    this.songs = songs;
    this.hub = hub;
    this.agents = agents;
    this.intermission = intermission;
    this.now = now;
    this.newCode = newCode;
    this.newToken = newToken;
  }

  private em() {
    return this.orm.em.fork();
  }

  /** Broadcasts the Room's state after the commands queued before it, so a newer state is never followed by an older one. */
  private republish(code: string) {
    this.withLock(code, () => this.publish(code)).catch(() => {});
  }

  private getRoom(code: string) {
    return this.em().findOne(Room, { code });
  }

  private async requireRoom(code: string): Promise<Room> {
    const room = await this.getRoom(normalizeCode(code));
    if (!room) throw new HttpError(404, 'room_not_found', 'Sala não encontrada.');
    return room;
  }

  private hostCheck(room: Room, token: string | undefined): boolean {
    if (!token) return false;
    const a = Buffer.from(String(token));
    const b = Buffer.from(room.hostToken);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  private requireHost(room: Room, actor: Actor) {
    if (!this.hostCheck(room, actor.hostToken)) throw new HttpError(403, 'host_only', 'Só o anfitrião da sala pode fazer isso.');
  }

  private async requireItem(room: Room, itemId: number): Promise<QueueItem> {
    const item = await this.em().findOne(QueueItem, { id: Number(itemId) });
    if (!item || item.room.code !== room.code || !['queued', 'playing'].includes(item.status)) {
      throw new HttpError(404, 'item_not_found', 'Música não encontrada na fila.');
    }
    return item;
  }

  private requireEditable(room: Room, item: QueueItem, actor: Actor) {
    if (!(this.hostCheck(room, actor.hostToken) || item.clientId === actor.clientId)) {
      throw new HttpError(403, 'not_your_item', 'Você só pode alterar as suas músicas.');
    }
  }

  private async touch(code: string) {
    const t = this.now();
    if (t - (this.touched.get(code) ?? 0) < TOUCH_EVERY_MS) return;
    this.touched.set(code, t);
    await this.em().nativeUpdate(Room, { code }, { lastActiveAt: t });
  }

  /** The songs' context in a Room: when it has a Session with local storage, the songs are in the owner's catalog. */
  private songCtx(room: Room) {
    return { sessionId: room.session?.id ?? null };
  }

  /** The playing item and the ones waiting, in the Queue's order. */
  private listActive(code: string) {
    return this.em().find(QueueItem, { room: code, status: { $in: ['queued', 'playing'] } }, { orderBy: { position: 'asc' } });
  }

  private async readySet(items: QueueItem[], room: Room): Promise<Set<string>> {
    const ids = [...new Set(items.map((item) => item.videoId))];
    const flags = await Promise.all(ids.map((id) => this.songs.isReady(id, this.songCtx(room))));
    return new Set(ids.filter((_, i) => flags[i]));
  }

  /**
   * Is the Intermission on in this Room now? The Host must have it on, it must last, and a TV must show it (with no TV
   * nothing plays: waiting would help nobody).
   */
  private intermissionOn(room: Room, ms: number): boolean {
    return ms > 0 && room.intermission && this.hub.count(room.code, 'tv') > 0;
  }

  /** Wakes the Room when an Intermission phase ends (the periodic step does it too; the alarm is just more punctual). */
  private wakeAt(code: string, ms: number) {
    const timer = setTimeout(() => {
      this.wakes.delete(timer);
      this.withLock(code, async () => {
        const staged = await this.endStage(code);
        const advanced = await this.tryAdvance(code);
        if (staged || advanced) await this.publish(code);
      }).catch(() => {});
    }, ms + 30);
    timer.unref?.();
    this.wakes.add(timer);
  }

  /** The end of the walk to the stage: the song of the Turn starts. */
  private async endStage(code: string): Promise<boolean> {
    const room = await this.getRoom(code);
    if (!room || room.playback !== 'intro' || (room.stageUntil ?? 0) > this.now()) return false;
    await this.em().nativeUpdate(Room, { code }, { playback: 'playing', stageUntil: null });
    return true;
  }

  /**
   * When nothing is playing, puts the next READY item on its Turn (items still being prepared keep their place). During the
   * applause the Queue waits; with the Intermission on, the song goes to "intro" (the singer walks to the stage) before it plays.
   */
  private async tryAdvance(code: string, { skipStage = false } = {}): Promise<boolean> {
    const room = await this.getRoom(code);
    if (!room || (room.currentItemId && room.playback !== 'idle')) return false;
    if ((room.applauseUntil ?? 0) > this.now()) return false;
    const queued = (await this.listActive(code)).filter((item) => item.status === 'queued');
    const pick = nextPlayable(queued, await this.readySet(queued, room), { fair: room.fair, lastClientId: room.lastClientId });
    if (!pick) {
      if (room.currentItemId || room.playback !== 'idle') await this.em().nativeUpdate(Room, { code }, { currentItemId: null, playback: 'idle', stageUntil: null });
      return false;
    }
    const stageMs = !skipStage && this.intermissionOn(room, this.intermission.stageMs) ? this.intermission.stageMs : 0;
    const at = this.now();
    await this.em().transactional(async (em) => {
      await em.nativeUpdate(QueueItem, { id: pick.id }, { status: 'playing', playedAt: at });
      // the base of the cache cleaning by use (the least recently sung go first)
      await em.upsert(SongSettings, { videoId: pick.videoId, lastPlayedAt: at }, { onConflictFields: ['videoId'], onConflictMergeFields: ['lastPlayedAt'] });
      await em.nativeUpdate(Room, { code }, {
        currentItemId: pick.id,
        playback: stageMs ? 'intro' : 'playing',
        stageUntil: stageMs ? at + stageMs : null,
        applauseItemId: null,
        applauseUntil: null,
        lastClientId: pick.clientId,
      });
    });
    if (stageMs) this.wakeAt(code, stageMs);
    this.positions.delete(code);
    return true;
  }

  /** What the Intermission shows of a song (who sang or will sing, the title and the Score, when there was scoring). */
  private interludeItem(item: QueueItem) {
    return {
      item_id: item.id,
      title: item.title ?? null,
      artist: item.artist ?? null,
      added_by: item.addedBy,
      guest: guestOf(item),
      singers: item.guestStatus === 'accepted' ? `${item.addedBy} & ${item.guestName}` : item.addedBy,
      score: Number.isInteger(item.score) ? item.score! : null,
    };
  }

  /** The Intermission phase under way (applause or the walk to the stage), with the time left; null outside the Intermission. */
  private async interludeOf(room: Room): Promise<Interlude | null> {
    const t = this.now();
    if (room.playback === 'intro' && room.currentItemId) {
      const item = await this.em().findOne(QueueItem, { id: room.currentItemId });
      if (item) return { phase: 'stage', total_ms: this.intermission.stageMs, left_ms: Math.max(0, (room.stageUntil ?? t) - t), ...this.interludeItem(item) };
    }
    if (!room.currentItemId && (room.applauseUntil ?? 0) > t && room.applauseItemId) {
      const item = await this.em().findOne(QueueItem, { id: room.applauseItemId });
      if (item) return { phase: 'applause', total_ms: this.intermission.applauseMs, left_ms: room.applauseUntil! - t, ...this.interludeItem(item) };
    }
    return null;
  }

  /** A line in the Session owner's history (Rooms without an owner, the classic worker's, have no owner statistics). */
  private async logPlay(room: Room, item: QueueItem | null, outcome: QueueStatus) {
    try {
      const session = room.session ? await this.em().findOne(Session, { id: room.session.id }) : null;
      if (!session || !item) return;
      await this.em().insert(PlayLog, {
        device: session.device.id,
        sessionId: session.id,
        videoId: item.videoId,
        title: item.title,
        artist: item.artist,
        singer: item.addedBy,
        singerKey: createHash('sha256').update(`${session.device.id}:${item.clientId}`).digest('hex').slice(0, 16),
        duet: item.guestStatus === 'accepted',
        score: item.score,
        cheers: item.cheers,
        outcome: outcome === 'done' ? 'done' : 'skipped',
        endedAt: this.now(),
      });
    } catch {
      // the history is an extra: it never breaks the Queue
    }
  }

  private async finishCurrent(code: string, status: QueueStatus) {
    const room = await this.getRoom(code);
    const current = room?.currentItemId;
    if (!room || !current) return;
    await this.logPlay(room, await this.em().findOne(QueueItem, { id: current }), status);
    await this.em().transactional(async (em) => {
      await em.nativeUpdate(QueueItem, { id: current }, { status });
      await em.nativeUpdate(Room, { code }, { currentItemId: null, playback: 'idle' });
    });
    this.positions.delete(code);
  }

  /** The Room's base state (with each item's client_id: run it through `personalize` before sending it to anyone). */
  private async snapshot(code: string): Promise<BaseRoomState> {
    const room = await this.requireRoom(code);
    const em = this.em();
    // the song playing comes first (with the Fair rotation it can have a higher position than those waiting)
    const items = (await this.listActive(room.code)).sort((a, b) => Number(b.status === 'playing') - Number(a.status === 'playing'));
    const ids = [...new Set(items.map((item) => item.videoId))];
    const ctx = this.songCtx(room);
    const described = new Map(await Promise.all(ids.map(async (id) => [id, await this.songs.describe(id, ctx)] as const)));
    const settings = new Map((await em.find(SongSettings, { videoId: { $in: ids } })).map((row) => [row.videoId, row]));
    const scored = await em.find(QueueItem, { room: room.code, score: { $ne: null } }, { orderBy: { score: 'desc', id: 'asc' }, limit: 10 });
    const position = this.positions.get(room.code);
    // who plays next: the same rule as the Queue's advance (only ready songs; the Fair rotation, when on)
    const ready = new Set(ids.filter((id) => described.get(id)?.media));
    const waiting = items.filter((item) => item.status === 'queued');
    const order = { fair: room.fair, lastClientId: room.lastClientId };
    const upNext = nextPlayable(waiting, ready, order);
    const sessionId = room.session?.id ?? null;
    return {
      code: room.code,
      fair: room.fair,
      scoring: room.scoring,
      voice: room.voice,
      voice_volume: room.voiceVolume ?? 40,
      melody_bars: room.melodyBars,
      // the Intermission: the Host's setting and the phase under way (applause or the walk to the stage)
      intermission: room.intermission,
      interlude: await this.interludeOf(room),
      scoreboard: scored.map((row) => ({ id: row.id, name: row.guestStatus === 'accepted' ? `${row.addedBy} & ${row.guestName}` : row.addedBy, title: row.title ?? null, score: row.score! })),
      // who is in the Room now (to invite to a Duet): only the name and an id that does not reveal the client_id
      people: this.hub.people(room.code).map((person) => ({ pid: pidOf(person.clientId), name: person.name })),
      play_order: playOrder(waiting, order).map((item) => item.id),
      playback: room.playback as Playback,
      current_item_id: room.currentItemId ?? null,
      next_item_id: upNext?.id ?? null,
      position_ms: position && position.item_id === room.currentItemId ? position.ms : 0,
      tv_connected: this.hub.count(room.code, 'tv') > 0,
      // the owner of the Room's Session (only the nickname and whether they are connected); null in Rooms without a Session
      owner: sessionId && this.agents ? await this.agents.ownerOf(sessionId) : null,
      // this Room's songs are on the owner's computer (local storage): only the TV there reaches them; the phone has no preview
      local_media: Boolean(sessionId && (await this.agents?.libraryOfSession(sessionId))),
      queue: items.map((item) => {
        const song = described.get(item.videoId);
        const meta = song?.meta as { title?: string; artist?: string; duration?: number; lyrics_source?: string; key?: SongKey } | null | undefined;
        return {
          id: item.id,
          video_id: item.videoId,
          title: meta?.title ?? item.title ?? null,
          artist: meta?.artist ?? item.artist ?? null,
          added_by: item.addedBy,
          // Duet: who sings along and whether they accepted; `singers` is what the TV and the scoreboard show ("Ana & Bia")
          guest: guestOf(item),
          guest_client_id: item.guestStatus ? (item.guestClientId ?? null) : null,
          singers: item.guestStatus === 'accepted' ? `${item.addedBy} & ${item.guestName}` : item.addedBy,
          client_id: item.clientId,
          pitch: item.pitch,
          backing: item.backing,
          guide: item.guide,
          status: item.status as 'queued' | 'playing',
          lyric_offset: Number(settings.get(item.videoId)?.lyricOffset ?? 0),
          // Duet: who sings each line, chosen by the singers (text of a b * -); null = the automatic split
          parts: item.guestStatus === 'accepted' ? (settings.get(item.videoId)?.parts ?? null) : null,
          song: {
            status: song?.status ?? 'unknown',
            stage: song?.stage ?? null,
            error: song?.error ?? null,
            error_code: song?.error_code ?? null,
            retry: song?.retry ?? null,
            ready: Boolean(song?.media),
            duration: meta?.duration ?? null,
            lyrics_source: meta?.lyrics_source ?? null,
            key: meta?.key ?? null,
            media: song?.media ?? null,
          },
        };
      }),
    };
  }

  // the Intermission's time left changes at each step: it does not count as a change of state (devices count it down themselves)
  private stateKey(base: BaseRoomState) {
    return JSON.stringify({ ...base, position_ms: 0, interlude: base.interlude && { ...base.interlude, left_ms: 0 } });
  }

  private publishBase(code: string, base: BaseRoomState) {
    this.lastKeys.set(code, this.stateKey(base));
    this.hub.broadcast(code, (conn) => ({ type: 'state', state: personalize(base, conn) }));
  }

  private async publish(code: string) {
    this.publishBase(code, await this.snapshot(code));
  }

  private async stateFor(code: string, actor: Actor) {
    const room = await this.requireRoom(code);
    return personalize(await this.snapshot(code), { clientId: actor.clientId, isHost: this.hostCheck(room, actor.hostToken) });
  }

  /** Applies a change under the Room's lock, advances the Queue when needed, broadcasts, and returns the asker's state. */
  private mutate<T extends object | void>(code: string, actor: Actor, change: (room: Room) => T | Promise<T>) {
    const normalized = normalizeCode(code);
    return this.withLock(normalized, async () => {
      const room = await this.requireRoom(normalized);
      const result = await change(room);
      await this.tryAdvance(normalized);
      await this.touch(normalized);
      await this.publish(normalized);
      return { ...(result ?? {}), state: await this.stateFor(normalized, actor) } as (T extends object ? T : object) & { state: Awaited<ReturnType<RoomService['stateFor']>> };
    });
  }

  /** Creates the Room. With `sessionId`, its song requests go to the agent that owns that Session. */
  async createRoom({ sessionId = null }: { sessionId?: string | null } = {}): Promise<CreatedRoom> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const code = this.newCode();
      const hostToken = this.newToken();
      const t = this.now();
      try {
        // the insert itself refuses a code already taken, so two Rooms created at once never share one
        await this.em().insert(Room, { code, hostToken, createdAt: t, lastActiveAt: t, session: sessionId, intermission: this.intermission.byDefault !== false });
        return { code, host_token: hostToken };
      } catch (error) {
        if (!(error instanceof UniqueConstraintViolationException)) throw error;
      }
    }
    throw new HttpError(503, 'no_room_code', 'Não consegui criar uma sala agora. Tente de novo.');
  }

  /** The Session the Room belongs to (null = a Room without one); 404 when the Room does not exist. */
  async sessionIdOf(code: string): Promise<string | null> {
    return (await this.requireRoom(code)).session?.id ?? null;
  }

  getState(code: string, actor: Actor) {
    return this.stateFor(normalizeCode(code), actor);
  }

  add(code: string, params: AddParams, actor: Actor): Promise<AddedSong> {
    return this.mutate(code, actor, async (room) => {
      const videoId = params.video_id ?? extractVideoId(params.url);
      if (!videoId) throw new HttpError(400, 'invalid_url', 'Link do YouTube inválido.');
      if (['text', 'file', 'align'].includes(params.lyrics?.source ?? '') && !params.lyrics?.text?.trim()) {
        throw new HttpError(400, 'lyrics_text_required', 'Informe o texto da letra.');
      }
      // a song not prepared yet needs the artist and the title (the lyrics search and the Queue depend on them); the ready
      // ones (the Jukebox) have them in their meta.json
      const artist = params.artist?.trim();
      const title = params.title?.trim();
      if (!(await this.songs.isReady(videoId, this.songCtx(room))) && !(artist && title)) {
        throw new HttpError(400, 'artist_title_required', 'Informe o artista e o nome da música.');
      }
      const em = this.em();
      if ((await em.count(QueueItem, { room: room.code, status: 'queued' })) >= MAX_QUEUE) throw new HttpError(409, 'queue_full', 'A fila está cheia.');
      if ((await em.count(QueueItem, { room: room.code, clientId: actor.clientId, status: 'queued' })) >= MAX_PER_CLIENT) {
        throw new HttpError(409, 'too_many', `Cada pessoa pode ter até ${MAX_PER_CLIENT} músicas na fila.`);
      }
      const song = await this.songs.request(videoId, { lyrics: params.lyrics, artist, title }, this.songCtx(room));
      if (song.error === 'imported_not_found') throw new HttpError(404, 'song_not_found', 'Esta música importada não está na biblioteca do dono.');
      const meta = song.song?.meta as { title?: string; artist?: string } | null | undefined;
      const last = await em.findOne(QueueItem, { room: room.code }, { orderBy: { position: 'desc' } });
      const itemId = await em.insert(QueueItem, {
        room: room.code,
        videoId,
        title: params.display_title ?? meta?.title ?? title ?? null,
        artist: artist ?? meta?.artist ?? null,
        addedBy: (params.name ?? '').trim().slice(0, 30) || 'Alguém',
        clientId: actor.clientId,
        pitch: clampPitch(params.pitch ?? 0),
        position: (last?.position ?? 0) + 1,
        createdAt: this.now(),
      });
      return { item_id: Number(itemId), cached: song.cached, deduped: song.deduped };
    });
  }

  /**
   * Duet: the song's owner (or the Host) invites someone who is IN THE ROOM now (`pid`, from the `people` list) to sing along.
   * The person has to accept. One guest per song; inviting again changes the guest. It holds for the songs waiting and for
   * the one playing.
   */
  invite(code: string, itemId: number, pid: string, actor: Actor) {
    return this.mutate(code, actor, async (room) => {
      const item = await this.requireItem(room, itemId);
      this.requireEditable(room, item, actor);
      // the song playing counts too: whoever accepts joins the Duet halfway through
      const guest = this.hub.people(room.code).find((person) => pidOf(person.clientId) === pid);
      if (!guest) throw new HttpError(404, 'person_not_found', 'Essa pessoa não está mais na sala.');
      if (guest.clientId === item.clientId) throw new HttpError(400, 'invite_self', 'Você não pode convidar a si mesmo.');
      await this.em().nativeUpdate(QueueItem, { id: item.id }, { guestClientId: guest.clientId, guestName: guest.name, guestStatus: 'pending' });
    });
  }

  /** The owner (or the Host) takes the invitation back, or takes the guest out. */
  cancelInvite(code: string, itemId: number, actor: Actor) {
    return this.mutate(code, actor, async (room) => {
      const item = await this.requireItem(room, itemId);
      this.requireEditable(room, item, actor);
      await this.em().nativeUpdate(QueueItem, { id: item.id }, { guestClientId: null, guestName: null, guestStatus: null });
    });
  }

  /** The guest accepts (sings along) or declines (the invitation goes away). */
  respondInvite(code: string, itemId: number, accept: boolean, actor: Actor) {
    return this.mutate(code, actor, async (room) => {
      const item = await this.requireItem(room, itemId);
      if (!actor.clientId || item.guestClientId !== actor.clientId || item.guestStatus !== 'pending') {
        throw new HttpError(404, 'invite_not_found', 'Este convite não existe mais.');
      }
      if (accept) await this.em().nativeUpdate(QueueItem, { id: item.id }, { guestStatus: 'accepted' });
      else await this.em().nativeUpdate(QueueItem, { id: item.id }, { guestClientId: null, guestName: null, guestStatus: null });
    });
  }

  remove(code: string, itemId: number, actor: Actor) {
    return this.mutate(code, actor, async (room) => {
      const item = await this.requireItem(room, itemId);
      this.requireEditable(room, item, actor);
      if (item.status === 'playing') await this.finishCurrent(room.code, 'skipped');
      else await this.em().nativeDelete(QueueItem, { id: item.id });
    });
  }

  /**
   * Swaps places with the neighbour. Moving down ("giving up the Turn": putting off one's own song by one place, e.g. a trip to
   * the bathroom) the owner may do too; moving up only the Host, otherwise anyone would jump the Queue.
   */
  move(code: string, itemId: number, direction: 'up' | 'down', actor: Actor) {
    return this.mutate(code, actor, async (room) => {
      const item = await this.requireItem(room, itemId);
      if (direction === 'up') this.requireHost(room, actor);
      else this.requireEditable(room, item, actor);
      if (item.status !== 'queued') throw new HttpError(409, 'not_queued', 'Só dá para mover músicas que aguardam.');
      const queued = (await this.listActive(room.code)).filter((other) => other.status === 'queued');
      const target = queued.find((other) => other.id === swapTarget(queued.map((other) => other.id), item.id, direction));
      if (!target) return;
      await this.em().transactional(async (em) => {
        await em.nativeUpdate(QueueItem, { id: item.id }, { position: target.position });
        await em.nativeUpdate(QueueItem, { id: target.id }, { position: item.position });
      });
    });
  }

  /** A Queue song's Key, backing vocals level and original voice level (the guide): only who chose it (or the Host) changes them. */
  setItemSettings(code: string, itemId: number, { pitch, backing, guide }: { pitch?: number; backing?: number; guide?: number }, actor: Actor) {
    return this.mutate(code, actor, async (room) => {
      const item = await this.requireItem(room, itemId);
      this.requireEditable(room, item, actor);
      await this.em().nativeUpdate(QueueItem, { id: item.id }, {
        ...(pitch === undefined ? {} : { pitch: clampPitch(pitch) }),
        ...(backing === undefined ? {} : { backing: clampBacking(backing) }),
        ...(guide === undefined ? {} : { guide: clampGuide(guide) }),
      });
    });
  }

  /**
   * Skips the song playing (Host only). With `itemId` (the song on the Host's screen), a song that already ended is not
   * skipped again: otherwise a skip arriving right after the TV's "ended" would skip the next singer's song.
   */
  skip(code: string, actor: Actor, itemId: number | null = null) {
    return this.mutate(code, actor, async (room) => {
      this.requireHost(room, actor);
      if (itemId !== null && room.currentItemId !== itemId) return;
      await this.finishCurrent(room.code, 'skipped');
    });
  }

  /** Skips the Intermission (Host only): the applause and the walk to the stage end, and the song of the Turn plays now. */
  startNow(code: string, actor: Actor) {
    return this.mutate(code, actor, async (room) => {
      this.requireHost(room, actor);
      if (room.playback === 'intro') {
        await this.em().nativeUpdate(Room, { code: room.code }, { playback: 'playing', stageUntil: null });
      } else if ((room.applauseUntil ?? 0) > this.now()) {
        await this.em().nativeUpdate(Room, { code: room.code }, { applauseItemId: null, applauseUntil: null });
        await this.tryAdvance(room.code, { skipStage: true });
      }
    });
  }

  /**
   * Moves the song playing (Host only): `{ to }` goes to that point (seconds, the dragged progress bar); `{ seconds }` moves
   * forward or back that much. The TV, which owns the position, does it.
   */
  seek(code: string, { seconds, to }: { seconds?: number; to?: number }, actor: Actor) {
    return this.mutate(code, actor, (room) => {
      this.requireHost(room, actor);
      const itemId = room.currentItemId;
      if (!itemId) return;
      this.hub.broadcast(room.code, (conn) => (conn.role === 'tv' ? { type: 'seek', item_id: itemId, ...(to === undefined ? { seconds } : { to }) } : null));
    });
  }

  setPlayback(code: string, playing: boolean, actor: Actor) {
    return this.mutate(code, actor, async (room) => {
      this.requireHost(room, actor);
      if (room.currentItemId) await this.em().nativeUpdate(Room, { code: room.code }, { playback: playing ? 'playing' : 'paused' });
    });
  }

  /**
   * The Room's settings, the Host's alone: `fair` (the Fair rotation), `scoring` (scoring through the microphone), `voice`
   * (the TV microphone's voice comes out of the speakers with the song), `voice_volume` (0 to 100), `melody_bars` (the melody
   * guide on the TV) and `intermission`.
   */
  setSettings(code: string, settings: RoomSettings, actor: Actor) {
    return this.mutate(code, actor, async (room) => {
      this.requireHost(room, actor);
      const fields: Partial<Pick<Room, 'fair' | 'scoring' | 'voice' | 'melodyBars' | 'voiceVolume' | 'intermission' | 'applauseItemId' | 'applauseUntil' | 'stageUntil' | 'playback'>> = {};
      if (typeof settings.fair === 'boolean') fields.fair = settings.fair;
      if (typeof settings.scoring === 'boolean') fields.scoring = settings.scoring;
      if (typeof settings.voice === 'boolean') fields.voice = settings.voice;
      if (typeof settings.melody_bars === 'boolean') fields.melodyBars = settings.melody_bars;
      if (Number.isInteger(settings.voice_volume)) fields.voiceVolume = Math.min(100, Math.max(0, settings.voice_volume!));
      if (typeof settings.intermission === 'boolean') {
        fields.intermission = settings.intermission;
        // turned off during the Intermission: the applause ends and the song of the Turn starts
        if (!settings.intermission) {
          Object.assign(fields, { applauseItemId: null, applauseUntil: null, stageUntil: null });
          if (room.playback === 'intro') fields.playback = 'playing';
        }
      }
      if (Object.keys(fields).length) await this.em().nativeUpdate(Room, { code: room.code }, fields);
    });
  }

  /** The final Score the TV sends as the song ends (only with scoring on, and for the item playing). */
  tvScore(code: string, itemId: number, score: number) {
    const normalized = normalizeCode(code);
    return this.withLock(normalized, async () => {
      const room = await this.getRoom(normalized);
      const item = await this.em().findOne(QueueItem, { id: itemId });
      if (!room?.scoring || !item || item.room.code !== room.code || item.status !== 'playing') return;
      if (!Number.isInteger(score) || score < 0 || score > 100) return;
      await this.em().nativeUpdate(QueueItem, { id: item.id }, { score });
      await this.publish(normalized);
    });
  }

  setOffset(code: string, videoId: string, offset: number, actor: Actor) {
    return this.mutate(code, actor, async (room) => {
      this.requireHost(room, actor);
      await this.em().upsert(SongSettings, { videoId, lyricOffset: clampOffset(offset) }, { onConflictFields: ['videoId'], onConflictMergeFields: ['lyricOffset'] });
    });
  }

  /**
   * A Duet's lyrics split: it holds for the song in any Room. Who changes it: the Host, or one of the singers of such a song
   * in the Queue (the owner and the guest). `parts` null goes back to the automatic split.
   */
  setParts(code: string, videoId: string, parts: string | null, actor: Actor) {
    let clean: string | null;
    try {
      clean = cleanParts(parts);
    } catch {
      return Promise.reject(new HttpError(400, 'invalid_parts', 'Divisão da letra inválida.'));
    }
    return this.mutate(code, actor, async (room) => {
      const mine = (await this.listActive(room.code)).some(
        (item) => item.videoId === videoId && (item.clientId === actor.clientId || (item.guestStatus === 'accepted' && item.guestClientId === actor.clientId)),
      );
      if (!(this.hostCheck(room, actor.hostToken) || mine)) throw new HttpError(403, 'not_your_item', 'Você só pode alterar as suas músicas.');
      await this.em().upsert(SongSettings, { videoId, parts: clean }, { onConflictFields: ['videoId'], onConflictMergeFields: ['parts'] });
    });
  }

  /** The TV's event: the song ended (ignored when it is not the current one: idempotent). */
  tvEnded(code: string, itemId: number) {
    const normalized = normalizeCode(code);
    return this.withLock(normalized, async () => {
      const room = await this.getRoom(normalized);
      if (!room || room.currentItemId !== itemId) return;
      await this.finishCurrent(normalized, 'done');
      // a natural end: applause for whoever sang, before the next one walks to the stage
      if (this.intermissionOn(room, this.intermission.applauseMs)) {
        await this.em().nativeUpdate(Room, { code: normalized }, { applauseItemId: itemId, applauseUntil: this.now() + this.intermission.applauseMs });
        this.wakeAt(normalized, this.intermission.applauseMs);
      }
      await this.tryAdvance(normalized);
      await this.publish(normalized);
    });
  }

  /** The TV's event: the current position (ms). Only the phones get it; it does not go through the database. */
  tvPosition(code: string, itemId: number, ms: number) {
    const normalized = normalizeCode(code);
    this.positions.set(normalized, { item_id: itemId, ms });
    this.touch(normalized).catch(() => {});
    this.hub.broadcast(normalized, (conn) => (conn.role === 'controller' ? { type: 'position', item_id: itemId, ms } : null));
  }

  /** The TV's event: the lyrics of the song it loaded. They go to the phones (the Stage draws the lyrics with them). */
  async tvLyrics(code: string, itemId: number, cues: unknown) {
    const normalized = normalizeCode(code);
    const room = await this.getRoom(normalized);
    const clean = sanitizeCues(cues);
    if (!room || room.currentItemId !== itemId || !clean) return;
    this.lyricsCache.set(normalized, { item_id: itemId, cues: clean });
    this.hub.broadcast(normalized, (conn) => (conn.role === 'controller' ? { type: 'lyrics', item_id: itemId, cues: clean } : null));
  }

  /** The phone says the person's name (for the list of who is in the Room, used by the Duet invitations). */
  rename(conn: Connection, name: unknown) {
    if (conn.role !== 'controller' || typeof name !== 'string') return;
    const clean = cleanName(name);
    if (clean === conn.name) return;
    conn.name = clean;
    this.republish(conn.code);
  }

  /** A Reaction (applause, fire...): it goes to the TV and to whoever watches the TV or the Stage, and counts for the song playing. */
  async react(conn: Connection, kind: unknown) {
    if (conn.role !== 'controller' || !REACTION_KINDS.includes(kind as never) || !conn.reactions.take(this.now())) return;
    if (!(await this.getRoom(conn.code))) return;
    // one statement: the cheer goes to the song playing when it arrives, never to the next one
    await this.em().getConnection().execute('UPDATE queue_items SET cheers = cheers + 1 WHERE id = (SELECT current_item_id FROM rooms WHERE code = ?)', [conn.code], 'run');
    this.hub.broadcast(conn.code, () => ({ type: 'reaction', kind, name: conn.name }));
  }

  /** Registers a WebSocket connection; returns it with `leave`, to call when it closes. Throws 404 when the Room does not exist. */
  async connect(code: string, { socket, role, clientId, hostToken, name }: { socket: RoomSocket; role?: string | null; clientId?: string | null; hostToken?: string | null; name?: string | null }) {
    const room = await this.requireRoom(code);
    const conn: Connection = {
      socket,
      code: room.code,
      role: role === 'tv' ? 'tv' : 'controller',
      clientId: clientId ?? '',
      name: name ? cleanName(name) : '',
      isHost: this.hostCheck(room, hostToken ?? ''),
      alive: true,
      reactions: createBucket(), // the limit on Reactions, per connection
    };
    const remove = this.hub.add(conn);
    // whoever arrives in the middle of a song (the singer's Stage opens after it started) gets the lyrics the TV already sent
    const cached = this.lyricsCache.get(room.code);
    if (conn.role === 'controller' && cached && cached.item_id === room.currentItemId && socket.readyState === 1) {
      socket.send(JSON.stringify({ type: 'lyrics', item_id: cached.item_id, cues: cached.cues }));
    }
    this.republish(room.code);
    return {
      conn,
      leave: () => {
        remove();
        this.republish(room.code);
      },
    };
  }

  /** An owner's statistics (a paired computer) since `since` (ms): totals, most played, who sang most, most cheered and the plays per day. */
  async statsFor(deviceId: string, since: number) {
    const sql = this.em().getConnection();
    const done = "device_id = ? AND ended_at >= ? AND outcome = 'done'";
    const totals = await sql.execute(
      `SELECT COUNT(*) AS songs, COUNT(DISTINCT singer_key) AS singers, COUNT(DISTINCT session_id) AS sessions,
              COALESCE(SUM(cheers), 0) AS cheers, ROUND(AVG(score), 1) AS avg_score, COALESCE(SUM(duet), 0) AS duets
         FROM play_log WHERE ${done}`, [deviceId, since], 'get');
    const skipped = await sql.execute("SELECT COUNT(*) AS n FROM play_log WHERE device_id = ? AND ended_at >= ? AND outcome = 'skipped'", [deviceId, since], 'get');
    const singers = await sql.execute(
      `SELECT singer_key, (SELECT singer FROM play_log p WHERE p.device_id = play_log.device_id AND p.singer_key = play_log.singer_key ORDER BY p.ended_at DESC LIMIT 1) AS name,
              COUNT(*) AS songs, ROUND(AVG(score), 1) AS avg_score
         FROM play_log WHERE ${done} GROUP BY singer_key ORDER BY songs DESC, MAX(ended_at) DESC LIMIT 10`, [deviceId, since]);
    return {
      totals: { ...totals, skipped: skipped.n },
      top_songs: await sql.execute(
        `SELECT video_id, MAX(title) AS title, MAX(artist) AS artist, COUNT(*) AS plays, ROUND(AVG(score), 1) AS avg_score
           FROM play_log WHERE ${done} GROUP BY video_id ORDER BY plays DESC, MAX(ended_at) DESC LIMIT 10`, [deviceId, since]),
      top_singers: singers.map(({ singer_key: _key, ...rest }: Record<string, unknown>) => rest),
      most_cheered: await sql.execute(
        `SELECT video_id, MAX(title) AS title, MAX(artist) AS artist, SUM(cheers) AS cheers
           FROM play_log WHERE ${done} GROUP BY video_id HAVING cheers > 0 ORDER BY cheers DESC LIMIT 5`, [deviceId, since]),
      by_day: await sql.execute(
        `SELECT date(ended_at / 1000, 'unixepoch') AS day, COUNT(*) AS songs
           FROM play_log WHERE ${done} GROUP BY day ORDER BY day`, [deviceId, since]),
    };
  }

  /** Deletes the Rooms idle since `before` (their Queues go with them); returns how many. */
  deleteInactiveRooms(before: number): Promise<number> {
    return this.em().nativeDelete(Room, { lastActiveAt: { $lt: before } });
  }

  /** Deletes the plays older than `before` from the history; returns how many. */
  prunePlayLog(before: number): Promise<number> {
    return this.em().nativeDelete(PlayLog, { endedAt: { $lt: before } });
  }

  /** The periodic step: advances the Queue when a song becomes ready and broadcasts changes (the preparation's progress). */
  async tick() {
    for (const code of this.hub.codes()) {
      await this.withLock(code, async () => {
        try {
          const staged = await this.endStage(code);
          const advanced = await this.tryAdvance(code);
          const base = await this.snapshot(code);
          if (staged || advanced || this.stateKey(base) !== this.lastKeys.get(code)) this.publishBase(code, base);
        } catch {
          // a Room deleted or the storage unavailable: it tries again at the next step
        }
      });
    }
  }

  start({ tickMs = 1500 } = {}) {
    const deleteInactive = () => this.deleteInactiveRooms(this.now() - ROOM_TTL_MS).catch(() => {});
    const prune = () => this.prunePlayLog(this.now() - PLAY_LOG_TTL_MS).catch(() => {});
    deleteInactive();
    prune();
    this.timers = [
      setInterval(() => this.tick(), tickMs),
      setInterval(() => this.hub.heartbeat(), 30_000),
      setInterval(deleteInactive, 60 * 60 * 1000),
      setInterval(prune, 24 * 60 * 60 * 1000),
    ];
    for (const timer of this.timers) timer.unref();
  }

  /** Stops the clocks and closes every connection (the API is shutting down). */
  stop() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
    for (const timer of this.wakes) clearTimeout(timer);
    this.wakes.clear();
    this.hub.closeAll();
  }
}
