// The contract between the app's window and its main process (src/main.ts): what the window sees (the snapshot and the tabs) and
// the actions it may call, which src/preload.cts exposes as `window.karaoke`. Types only: the main process, the preload and the
// screens import it with `import type`, so a change here shows wherever it reaches.

export type BrowserId = 'chrome' | 'edge' | 'auto';

export interface Microphone {
  id: string;
  label: string;
}

export interface EngineStatus {
  status: 'unknown' | 'missing' | 'building' | 'ready' | 'error';
  progress: { label: string; done?: number | null; total?: number | null } | null;
  error: string | null;
  /** cpu, cu121, rocm6.2 or mps. */
  kind: string | null;
  reason: string | null;
}

export interface AgentStatus {
  status: 'stopped' | 'starting' | 'online' | 'offline' | 'auth_error';
  session: { id: string; display_name: string } | null;
  error: string | null;
  /** This computer sends its songs to the cloud. */
  cloud?: boolean;
}

/** A Room open in the app: its TV and Host pages, from the server. */
export interface OpenRoom {
  code: string;
  tv: string;
  host: string;
}

/** What the server says of this app's version (GET /agent/v1/version). */
export interface UpdateInfo {
  current: string | null;
  status: 'ok' | 'update_available' | 'update_required' | 'unknown';
  latest: string | null;
  minimum: string | null;
  notes: string | null;
  url: string | null;
}

export interface YoutubeStatus {
  status: 'unknown' | 'connected' | 'not-logged';
  detail: string | null;
}

export interface LogLine {
  ts: number;
  level: 'info' | 'error';
  line: string;
}

/** Everything the window shows. */
export interface Snapshot {
  version: string;
  defaultServer: string;
  paired: boolean;
  /** false: the system has no vault for the device token, and the window warns. */
  tokenProtected: boolean;
  server: string;
  deviceName: string;
  nickname: string;
  microphone: Microphone | null;
  /** The first Session's choice of video card and microphone is done. */
  setupDone: boolean;
  browser: BrowserId;
  browserName: string;
  engineDir: string;
  libraryDir: string;
  phase: 'engine' | 'pair' | 'home';
  engine: EngineStatus;
  agent: AgentStatus;
  rooms: OpenRoom[];
  youtube: YoutubeStatus;
  update: UpdateInfo | null;
  /** While the update downloads. */
  updateProgress: { percent: number } | null;
  /** The long task under way (importing, the YouTube login...). */
  busy: string | null;
  logs: LogLine[];
}

/** The window's tabs: "Session" and "Rooms"; inside a Room, the TV and Host sub-tabs. */
export interface Tabs {
  tab: 'session' | 'rooms';
  rooms: string[];
  room: string | null;
  sub: 'tv' | 'host';
  settings: boolean;
}

export interface Gpu {
  name: string;
  vendor?: string;
  driver?: string;
  /** The engine this card runs (cu121, rocm6.2, mps); none when it cannot run one. */
  engine?: string | null;
}

/** What the worker finds in this computer (`--hardware`). */
export interface HardwareInfo {
  /** The engine it recommends. */
  engine: string;
  reason?: string;
  cpu_cores: number;
  ram_mb?: number;
  gpus?: Gpu[];
}

export interface LibraryStats {
  songs: number;
  bytes: number;
  avg_prepare_s: number | null;
  biggest: { title: string | null; artist: string | null; bytes: number }[];
}

/** The owner's statistics from the server (GET /agent/v1/stats). */
export interface ServerStats {
  days: number;
  since: number;
  totals: { songs: number; singers: number; sessions: number; cheers: number; avg_score: number | null; duets: number; skipped: number };
  top_songs: { video_id: string; title: string | null; artist: string | null; plays: number; avg_score: number | null }[];
  top_singers: { name: string; songs: number; avg_score: number | null }[];
  most_cheered: { video_id: string; title: string | null; artist: string | null; cheers: number }[];
  by_day: { day: string; songs: number }[];
}

export interface OwnerStats {
  server: ServerStats;
  library: LibraryStats;
}

/** Each action answers this way: the window never gets a raw exception. */
export type Result<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

/** The actions the window may call (`window.karaoke`). */
export interface KaraokeBridge {
  snapshot(): Promise<Result<Snapshot>>;
  buildEngine(options: { engine: string; switchEngine?: boolean }): Promise<Result<Snapshot>>;
  pair(pairing: { server: string; code: string; name: string }): Promise<Result<Snapshot>>;
  requestCode(request: { server: string; email: string }): Promise<Result<{ message: string }>>;
  unpair(): Promise<Result<Snapshot>>;
  startAgent(options: { nickname: string }): Promise<Result<Snapshot>>;
  stopAgent(): Promise<Result<Snapshot>>;
  createRoom(): Promise<Result<OpenRoom>>;
  youtubeLogin(): Promise<Result<YoutubeStatus | { cancelled: true }>>;
  youtubeStatus(): Promise<Result<YoutubeStatus>>;
  importFile(song: { file: string; artist: string; title: string }): Promise<Result<{ message: string }>>;
  hardware(): Promise<Result<HardwareInfo>>;
  stats(options: { days: number }): Promise<Result<OwnerStats>>;
  settings(patch: { nickname?: string; microphone?: Microphone | null; setupDone?: boolean }): Promise<Result<Snapshot>>;
  checkUpdate(): Promise<Result<UpdateInfo | null>>;
  applyUpdate(): Promise<Result<{ opened?: boolean; downloaded?: boolean; installing?: boolean }>>;
  loginItem(enabled?: boolean): Promise<Result<boolean>>;
  open(url: string): Promise<Result<void>>;
  pickAudio(): Promise<Result<string | null>>;
  pickFolder(): Promise<Result<string | null>>;
  setLibrary(dir: string): Promise<Result<Snapshot>>;
  cancelBusy(): Promise<Result<boolean>>;
  openRoom(code: string): Promise<Result<void>>;
  selectTab(tab: string): Promise<Result<void>>;
  selectRoom(code: string): Promise<Result<void>>;
  selectSub(sub: string): Promise<Result<void>>;
  closeRoom(code: string): Promise<Result<void>>;
  settingsOpen(open: boolean): Promise<Result<void>>;
  layout(top: number): Promise<Result<void>>;
  onState(callback: (snapshot: Snapshot) => void): () => void;
  onTabs(callback: (tabs: Tabs) => void): () => void;
}

/** The actions that answer a Result (the two `on…` subscribe instead). */
export type Action = Exclude<keyof KaraokeBridge, 'onState' | 'onTabs'>;

/** What an action answers when it works. */
export type DataOf<K extends Action> = Awaited<ReturnType<KaraokeBridge[K]>> extends Result<infer T> ? T : never;

/** What an action takes. */
export type ArgOf<K extends Action> = Parameters<KaraokeBridge[K]>[0];
