// Contrato da API de salas (o estado que o servidor difunde por WebSocket e devolve nas ações).

export interface SongKey {
  tonic: number;
  mode: string;
  name?: string;
  score?: number;
  margin?: number;
  alt?: { tonic: number; mode: string; name?: string };
}

/** O que se sabe de uma música da fila: processamento, letra, tom e os arquivos que a TV toca. */
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
  media: { instrumental: string; lyrics: string; melody: string | null } | null;
}

export interface QueueItem {
  id: number;
  video_id: string;
  title: string | null;
  artist: string | null;
  added_by: string;
  pitch: number;
  status: string;
  lyric_offset: number;
  mine: boolean;
  can_edit: boolean;
  song: SongView;
}

export interface ScoreRow {
  id: number;
  name: string;
  title: string | null;
  score: number;
}

export type Playback = 'idle' | 'playing' | 'paused';

export interface RoomState {
  code: string;
  fair: boolean;
  scoring: boolean;
  scoreboard: ScoreRow[];
  play_order: number[];
  playback: Playback;
  current_item_id: number | null;
  next_item_id: number | null;
  position_ms: number;
  tv_connected: boolean;
  queue: QueueItem[];
  me: { is_host: boolean };
}

/** Mensagens que o servidor envia pelo WebSocket da sala. */
export type ServerMessage =
  | { type: 'state'; state: RoomState }
  | { type: 'position'; item_id: number; ms: number }
  | { type: 'seek'; item_id: number; seconds: number };

/** Música da biblioteca (meta.json de uma música pronta). */
export interface LibrarySong {
  video_id: string;
  title: string | null;
  artist: string | null;
  /** Título original do vídeo no YouTube (a pessoa pode ter dado outro nome à música). */
  video_title?: string | null;
  duration: number | null;
  key?: SongKey | null;
}

export interface ApiError extends Error {
  status?: number;
  code?: string;
}
