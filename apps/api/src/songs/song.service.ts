// The song service: the library (the cache), the preparation state and the job requests. The song routes and the Rooms (adding
// to the queue) use it.
//
// A song can be in one of two places:
//  - in the SERVER's storage (the classic way: the worker and the API share the `storage/` folder);
//  - on the Session OWNER's COMPUTER (local storage): the cloud does not see the files, only the catalog the agent publishes
//    (the meta.json and which files exist) and the address of the local media server the browser fetches them from.
// Which one applies depends on the context `{ sessionId }`: if the Session has a `media_base`, its catalog; otherwise, the server.
import type { JobStore } from '../app.ts';
import type { LegacyServices } from '../legacy.module.ts';
import type { LocalStorage } from '../storage.js';

/** Where a request comes from: a Room's Session (its owner's agent answers it) or none (the classic worker). */
export interface SongContext {
  sessionId?: string | null;
}

/** The files of a ready song (null where an optional file does not exist). */
export interface SongMedia {
  instrumental: string;
  lyrics: string;
  melody: string | null;
  backing: string | null;
  vocals: string | null;
  /** The files are on the owner's computer: only their browser (the TV) reaches them. */
  local: boolean;
}

export interface SongState {
  video_id: string;
  status: string;
  stage: string | null;
  error: string | null;
  error_code: string | null;
  retry: string | null;
  meta: Record<string, unknown> | null;
  media: SongMedia | null;
}

export interface ExportState {
  status: string;
  url: string | null;
  error: string | null;
  local?: boolean;
}

export interface LyricsChoice {
  source: string;
  text?: string;
  loose?: boolean;
}

const keys = (id: string) => ({
  instrumental: `cache/${id}/instrumental.mp3`,
  lyrics: `cache/${id}/lyrics.json`,
  meta: `cache/${id}/meta.json`,
  melody: `cache/${id}/melody.json`, // optional: the original voice's melody, for scoring
  backing: `cache/${id}/backing.mp3`, // optional: the backing vocals alone, for their level control
  vocals: `cache/${id}/vocals.mp3`, // optional: the isolated original voice, as a guide for singing (never goes to the cloud)
});

/** The exported MP4's key: the same name the worker uses (karaoke.mp4, karaoke_p+2.mp4, karaoke_p-3.mp4). */
export const exportKey = (id: string, pitch: number) => `cache/${id}/karaoke${pitch === 0 ? '' : `_p${pitch > 0 ? '+' : '-'}${Math.abs(pitch)}`}.mp4`;

/** An imported song (a file or an open source of the owner): "f-" + 12 hex digits. It does not come from YouTube: nothing to download. */
const isImported = (id: string) => id.startsWith('f-');

const ACTIVE_JOB = ['pending', 'processing', 'needs_lyrics', 'failed'];

export class SongService {
  constructor(
    private readonly storage: LocalStorage,
    private readonly jobs: JobStore,
    private readonly agents: LegacyServices['agents'] | null = null,
  ) {}

  /** The context's local catalog (whose it is and where the media is), or null: the song is on the server. */
  private localOf({ sessionId = null }: SongContext = {}) {
    return this.agents && sessionId ? this.agents.libraryOfSession(sessionId) : null;
  }

  private localUrl(lib: { mediaBase: string }, key: string) {
    return `${lib.mediaBase}/${key}`;
  }

  /**
   * A pending request whose owner VANISHED (a Session without a signal) must not hold the song for everyone else: it is released
   * (it fails with "the owner left") and the new request goes on. If its owner is online, the request stays with them (dedupe).
   */
  private async releaseStale(id: string, sessionId: string | null) {
    const job = await this.jobs.get(id);
    if (!job?.session_id || job.session_id === sessionId || !['pending', 'processing'].includes(job.status)) return;
    if (this.agents?.isOnline(job.session_id)) return;
    await this.jobs.release?.(id);
  }

  /** Ready in the catalog of this Session owner's computer? */
  private localReady(lib: { deviceId: string }, id: string) {
    const files = this.agents?.librarySong(lib.deviceId, id)?.files;
    return Boolean(files?.instrumental && files?.lyrics);
  }

  /** Ready in the server's storage (the "cloud")? All three files exist: the partial folder of an interrupted job does not count. */
  private async cloudReady(id: string) {
    const k = keys(id);
    const found = await Promise.all([this.storage.exists(k.instrumental), this.storage.exists(k.lyrics), this.storage.exists(k.meta)]);
    return found.every(Boolean);
  }

  /**
   * "Ready": in the Session's local catalog OR in the cloud (songs authorized computers sent: any Session uses them without
   * downloading them from YouTube again).
   */
  async isReady(id: string, ctx?: SongContext): Promise<boolean> {
    const lib = this.localOf(ctx);
    if (lib && this.localReady(lib, id)) return true;
    return this.cloudReady(id);
  }

  private async readMeta(id: string): Promise<Record<string, unknown>> {
    return JSON.parse((await this.storage.read(keys(id).meta)).toString('utf-8'));
  }

  /** The addresses of a ready song's files. */
  private async mediaOf(id: string, ctx?: SongContext): Promise<SongMedia> {
    const lib = this.localOf(ctx);
    const k = keys(id);
    if (lib && this.localReady(lib, id)) { // the owner's computer is faster: their TV fetches from there
      const files = this.agents?.librarySong(lib.deviceId, id)?.files;
      return {
        instrumental: this.localUrl(lib, k.instrumental),
        lyrics: this.localUrl(lib, k.lyrics),
        melody: files?.melody ? this.localUrl(lib, k.melody) : null,
        backing: files?.backing ? this.localUrl(lib, k.backing) : null,
        vocals: files?.vocals ? this.localUrl(lib, k.vocals) : null,
        local: true,
      };
    }
    return {
      instrumental: this.storage.getUrl(k.instrumental),
      lyrics: this.storage.getUrl(k.lyrics),
      melody: (await this.storage.exists(k.melody)) ? this.storage.getUrl(k.melody) : null,
      backing: (await this.storage.exists(k.backing)) ? this.storage.getUrl(k.backing) : null,
      vocals: (await this.storage.exists(k.vocals)) ? this.storage.getUrl(k.vocals) : null,
      local: false,
    };
  }

  /** A song's public state (null if it was never asked for). */
  async describe(id: string, ctx?: SongContext): Promise<SongState | null> {
    const [job, ready] = await Promise.all([this.jobs.get(id), this.isReady(id, ctx)]);
    if (!job && !ready) return null;
    // only the "ready" record is left in Redis but the files were deleted (cache cleaning): as if it never existed
    if (!ready && job?.status === 'ready') return null;
    // a job under way (e.g. changing the lyrics) wins over the earlier "ready"
    const jobActive = Boolean(job && ACTIVE_JOB.includes(job.status));
    const status = jobActive ? job.status : ready ? 'ready' : job.status;
    const lib = this.localOf(ctx);
    return {
      video_id: id,
      status,
      stage: jobActive ? job.stage : null,
      error: jobActive ? job.error : null,
      error_code: jobActive ? job.error_code ?? null : null,
      retry: jobActive ? job.retry ?? null : null,
      meta: ready ? (lib && this.localReady(lib, id) ? this.agents?.librarySong(lib.deviceId, id)?.meta : await this.readMeta(id)) : null,
      media: ready ? await this.mediaOf(id, ctx) : null,
    };
  }

  private payloadFor(id: string, { lyrics, artist, title }: { lyrics?: LyricsChoice; artist?: string; title?: string }) {
    const choice = lyrics ?? { source: 'auto' };
    return {
      url: `https://www.youtube.com/watch?v=${id}`, // always canonical: the user does not choose yt-dlp's target
      lyrics_source: choice.source,
      ...(choice.text ? { lyrics_text: choice.text } : {}),
      ...(choice.loose ? { lyrics_loose: true } : {}),
      ...(artist ? { artist } : {}),
      ...(title ? { title } : {}),
    };
  }

  /** The MP4's state in a key: the file existing is the truth (the state in Redis expires). */
  async exportInfo(id: string, pitch: number, ctx?: SongContext): Promise<ExportState> {
    const lib = this.localOf(ctx);
    if (lib) {
      // the agent publishes in the catalog the keys that already have an MP4 on the owner's computer
      const exports: number[] = this.agents?.librarySong(lib.deviceId, id)?.files.exports ?? [];
      if (exports.includes(pitch)) return { status: 'ready', url: this.localUrl(lib, exportKey(id, pitch)), error: null, local: true };
    } else {
      const key = exportKey(id, pitch);
      if (await this.storage.exists(key)) return { status: 'ready', url: this.storage.getUrl(key), error: null };
    }
    const state = await this.jobs.exportState(id, pitch);
    // "ready" without a file = cache cleaning: as if it was never asked for
    return state && state.status !== 'ready' ? { ...state, url: null } : { status: 'none', url: null, error: null };
  }

  /** Asks for the MP4 (instrumental + lyrics) in the chosen key. */
  async requestExport(id: string, pitch: number, ctx: SongContext = {}): Promise<{ error: 'not_found' | 'not_ready' } | { export: ExportState }> {
    if (!(await this.describe(id, ctx))) return { error: 'not_found' };
    if (!(await this.isReady(id, ctx))) return { error: 'not_ready' };
    if ((await this.exportInfo(id, pitch, ctx)).status !== 'ready') await this.jobs.requestExport(id, pitch, { sessionId: ctx.sessionId ?? null });
    return { export: await this.exportInfo(id, pitch, ctx) };
  }

  /** Ready songs (their meta.json): the owner's catalog when the Session has local storage, plus the server's. */
  async list(ctx: SongContext = {}): Promise<Record<string, unknown>[]> {
    const lib = this.localOf(ctx);
    const local: { video_id: string }[] = lib && this.agents ? this.agents.libraryList(lib.deviceId) : [];
    const metaKeys = (await this.storage.list('cache')).filter((key: string) => key.endsWith('/meta.json'));
    const songs = [];
    for (const key of metaKeys) {
      const id = key.split('/')[1];
      if ((await this.cloudReady(id)) && !local.some((song) => song.video_id === id)) songs.push(await this.readMeta(id));
    }
    return [...local, ...songs];
  }

  /**
   * Uses the cache when ready; otherwise creates a job (or reuses the one under way: dedupe).
   * `sessionId`: the job goes to the agent that owns the Session (without it, to the classic worker).
   */
  async request(
    id: string,
    body: { lyrics?: LyricsChoice; artist?: string; title?: string } = {},
    { sessionId = null }: SongContext = {},
  ): Promise<{ error: 'imported_not_found' } | { error?: undefined; cached: boolean; created: boolean; deduped: boolean; song: SongState | null }> {
    const explicitLyrics = Boolean(body.lyrics && body.lyrics.source !== 'auto');
    const ctx = { sessionId };
    if ((await this.isReady(id, ctx)) && !explicitLyrics) {
      return { cached: true, created: false, deduped: false, song: await this.describe(id, ctx) };
    }
    // imported and not in the library: no agent would download it (only its owner has it, on their computer)
    if (isImported(id)) return { error: 'imported_not_found' };
    await this.releaseStale(id, sessionId);
    const { created } = await this.jobs.enqueue(id, this.payloadFor(id, body), { replace: explicitLyrics, sessionId });
    return { cached: false, created, deduped: !created, song: await this.describe(id, ctx) };
  }

  /** Chooses or changes the lyrics (reusing the cached instrumental). */
  async setLyrics(
    id: string,
    lyrics: LyricsChoice,
    { artist, title }: { artist?: string; title?: string } = {},
    { sessionId = null }: SongContext = {},
  ): Promise<{ error: 'not_found' | 'imported' | 'in_progress' } | { error?: undefined; song: SongState | null }> {
    const ctx = { sessionId };
    if (!(await this.describe(id, ctx))) return { error: 'not_found' };
    if (isImported(id)) return { error: 'imported' }; // an imported song's lyrics change by importing the file again
    await this.releaseStale(id, sessionId);
    const { created } = await this.jobs.enqueue(id, this.payloadFor(id, { lyrics, artist, title }), { replace: true, sessionId });
    if (!created) return { error: 'in_progress' };
    return { song: await this.describe(id, ctx) };
  }
}
