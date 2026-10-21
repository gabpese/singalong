// The contract between the API and the pages (ADR 0017): the Room's state, the WebSocket messages both ways, and the HTTP
// answers the pages read. The API's code is checked against these types, and the web and the admin page import them with
// `import type`, so a shape changes in one place. This file imports nothing: their compilers read it too, without the API's
// dependencies.

/** The key a song is in, from its analysis (meta.json). */
export interface SongKey {
  tonic: number;
  mode: string;
  name?: string;
  score?: number;
  margin?: number;
  alt?: { tonic: number; mode: string; name?: string };
}

/** Where a ready song's files are. `local`: on the owner's computer (its local media server), not on the server. */
export interface SongMedia {
  instrumental: string;
  lyrics: string;
  melody: string | null;
  backing: string | null;
  vocals: string | null;
  local: boolean;
}

/** What is known of a Queue song: its preparation, lyrics, key and the files the TV plays. */
export interface SongView {
  status: string;
  stage: string | null;
  error: string | null;
  error_code: string | null;
  retry: string | null;
  ready: boolean;
  duration: number | null;
  lyrics_source: string | null;
  key: SongKey | null;
  media: SongMedia | null;
}

/** Duet: the guest and whether they accepted (their client_id never reaches the browser). */
export interface Guest {
  name: string;
  status: 'pending' | 'accepted';
}

/** A Queue item, as one person sees it. */
export interface QueueItem {
  id: number;
  video_id: string;
  title: string | null;
  artist: string | null;
  added_by: string;
  /** Who sings: the name of who added it, or "Ana & Bia" in an accepted Duet. */
  singers: string;
  guest: Guest | null;
  /** I sing along in this song (I accepted the invitation). */
  guest_me: boolean;
  /** I was invited to this song and have not answered yet. */
  invite_for_me: boolean;
  /** The Key, in semitones. */
  pitch: number;
  /** The backing vocals' level (0..100 %); it only counts when the song has the backing file. */
  backing: number;
  /** The original voice's level, as a guide for singing (0..100 %). */
  guide: number;
  /** Duet: who sings each lyrics line, chosen by the singers (text of a b * -); null = the automatic split. */
  parts: string | null;
  status: 'queued' | 'playing';
  lyric_offset: number;
  mine: boolean;
  can_edit: boolean;
  song: SongView;
}

/** A line of the Room's scoreboard. */
export interface ScoreRow {
  id: number;
  name: string;
  title: string | null;
  score: number;
}

/** `intro`: the song of the Turn is chosen, but the singer is still walking to the stage (the sound waits for the Intermission). */
export type Playback = 'idle' | 'intro' | 'playing' | 'paused';

/**
 * The Intermission under way: the applause for who just sang (`applause`) or the walk to the stage of who comes next (`stage`).
 * `left_ms` is what was left when the server sent the state: each device counts the rest down by itself.
 */
export interface Interlude {
  phase: 'applause' | 'stage';
  total_ms: number;
  left_ms: number;
  item_id: number;
  title: string | null;
  artist: string | null;
  added_by: string;
  guest: Guest | null;
  singers: string;
  /** The Score of who just sang (only during the applause, with scoring on). */
  score: number | null;
}

/** The Room's state, as one person sees it: in every `state` message and in the answer to each command. */
export interface RoomState {
  code: string;
  fair: boolean;
  scoring: boolean;
  /** The TV microphone's voice comes out of the speakers with the song (the Host turns it on), at this volume (0 to 100). */
  voice: boolean;
  voice_volume: number;
  /** The melody guide on the TV: the original voice's notes as bars, with the singer's pitch on top. */
  melody_bars: boolean;
  /** The Intermission (the Host turns it on): applause after each song and the next singer's walk to the stage. */
  intermission: boolean;
  interlude: Interlude | null;
  scoreboard: ScoreRow[];
  play_order: number[];
  playback: Playback;
  current_item_id: number | null;
  next_item_id: number | null;
  position_ms: number;
  tv_connected: boolean;
  /** The owner of the Room's Session (the local agent): only the nickname and whether they are connected; null without a Session. */
  owner: { nickname: string; online: boolean } | null;
  /** The Room's songs are on the owner's computer: no instrumental preview on the phone. */
  local_media: boolean;
  queue: QueueItem[];
  me: { is_host: boolean; pid: string | null };
  /** Who is in the Room now (to invite to a Duet): the name and an id that does not reveal the client_id. */
  people: { pid: string; name: string }[];
}

/** A synced lyrics line (lyrics.json). `words` = [start, end] of each word, when there was an alignment. */
export interface LyricCue {
  start: number;
  end: number;
  text: string;
  words?: [number, number][];
}

/** The Reactions the phones send to the TV. */
export type ReactionKind = 'clap' | 'fire' | 'heart' | 'party' | 'wow';

/** What the server sends over the Room's WebSocket. */
export type ServerMessage =
  | { type: 'state'; state: RoomState }
  | { type: 'reaction'; kind: ReactionKind; name: string }
  | { type: 'position'; item_id: number; ms: number }
  | { type: 'lyrics'; item_id: number; cues: LyricCue[] }
  | { type: 'seek'; item_id: number; seconds?: number; to?: number };

/** What the devices send over the Room's WebSocket: the phones their name and Reactions, the TV the song's progress. */
export type ClientMessage =
  | { type: 'hello'; name: string }
  | { type: 'reaction'; kind: ReactionKind }
  | { type: 'position'; item_id: number; ms: number }
  | { type: 'lyrics'; item_id: number; cues: LyricCue[] }
  | { type: 'score'; item_id: number; score: number }
  | { type: 'ended'; item_id: number };

// --- HTTP answers ---

/** POST /api/rooms: the new Room and its Host's token. */
export interface CreatedRoom {
  code: string;
  host_token: string;
}

/** POST /api/rooms/:code/queue: the item added, whether the song was ready (`cached`) or already asked for (`deduped`). */
export interface AddedSong {
  item_id: number;
  cached: boolean;
  deduped: boolean;
  state: RoomState;
}

/** One system's installer. */
export interface Download {
  system: 'windows' | 'macos' | 'linux';
  arch: string;
  file: string;
  url: string;
}

/** GET /api/config: what the landing page and the TV need. */
export interface PublicConfig {
  /** The address phones open (the QR code); null = the page's own. */
  public_url: string | null;
  app_download_url: string | null;
  app_latest_version: string | null;
  /** The page with every version. */
  app_page_url: string | null;
  app_downloads: Download[];
}

/** GET /api/search: a YouTube video to add. */
export interface SearchResult {
  video_id: string;
  title: string;
  channel?: string | null;
  duration?: number | null;
  thumbnail: string;
}

/** GET /api/songs: a song in the Jukebox (its meta.json). */
export interface LibrarySong {
  video_id: string;
  title: string | null;
  artist: string | null;
  /** The video's original title on YouTube (the person may have named the song otherwise). */
  video_title?: string | null;
  duration: number | null;
  key?: SongKey | null;
}

/** The MP4 export in one Key: `ready` with its address, or still being made. */
export interface ExportState {
  status: string;
  url: string | null;
  error: string | null;
  /** The file is on the owner's computer. */
  local?: boolean;
}

/** A published app version; an empty field is not set. */
export interface ReleaseFields {
  latest: string;
  minimum: string;
  notes: string;
  url: string;
}

/** What applies now, with where it came from: `panel` (the admin page), `env` (APP_* variables) or `none` (nothing set). */
export interface PublishedRelease extends ReleaseFields {
  source: 'panel' | 'env' | 'none';
  updated_at: number | null;
}

/** What the installed app should do: up to date, an update available, an update required, or unknown. */
export type UpdateStatus = 'ok' | 'update_available' | 'update_required' | 'unknown';

/** A paired computer, on the admin page. */
export interface AdminDevice {
  id: string;
  name: string;
  /** The e-mail the pairing code went to; null when it paired without one. */
  email: string | null;
  created_at: number;
  last_seen: number | null;
  revoked: boolean;
  /** It sends its songs to the cloud. */
  cloud: boolean;
  /** The app version it reported. */
  version: string | null;
  update_status: UpdateStatus;
}

/** A prepared song in the server's storage, on the admin page. */
export interface CloudSong {
  id: string;
  title: string | null;
  artist: string | null;
  /** Its files' bytes. */
  size: number;
  updated: number;
  /** `youtube`, `file` (the owner's own file) or `url:<site>`. */
  origin: string;
}

/** GET /<ADMIN_PATH>/api/state: everything the admin page shows. */
export interface AdminState {
  /** The published version, and what the .env would say if the page's were cleared. */
  release: PublishedRelease & { env: ReleaseFields };
  mail: { enabled: boolean };
  emails: {
    rules: { email: string; can_pair: boolean; can_cloud: boolean }[];
    /** From the .env: they only change there. */
    fixed: { pair: string[]; cloud: string[] };
  };
  /** Newest first. */
  devices: AdminDevice[];
  cloud: CloudSong[];
  cloud_total: number;
  blocked: { video_id: string; blocked_at: number }[];
}
