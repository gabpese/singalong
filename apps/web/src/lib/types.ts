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
  /** `local`: os arquivos estão no computador do dono (servidor local de mídia), não no servidor. */
  media: { instrumental: string; lyrics: string; melody: string | null; backing: string | null; vocals?: string | null; local?: boolean } | null;
}

export interface QueueItem {
  id: number;
  video_id: string;
  title: string | null;
  artist: string | null;
  added_by: string;
  /** Quem canta: o nome de quem adicionou, ou "Ana & Bia" num dueto já aceito. */
  singers: string;
  /** Dueto: o convidado e se já aceitou (o client_id dele nunca chega ao navegador). */
  guest: { name: string; status: 'pending' | 'accepted' } | null;
  /** Eu vou cantar junto nesta música (aceitei o convite). */
  guest_me: boolean;
  /** Me convidaram para esta música e ainda não respondi. */
  invite_for_me: boolean;
  pitch: number;
  /** Nível das vozes de apoio (0..100 %); só vale se a música tem o arquivo de apoio. */
  backing: number;
  /** Nível da voz original, como guia para cantar (0..100 %). */
  guide: number;
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
  /** A voz do microfone da TV sai nas caixas junto com a música (o anfitrião liga) e o volume dela, de 0 a 100. */
  voice: boolean;
  voice_volume: number;
  scoreboard: ScoreRow[];
  play_order: number[];
  playback: Playback;
  current_item_id: number | null;
  next_item_id: number | null;
  position_ms: number;
  tv_connected: boolean;
  /** O dono da sessão da sala (agente local): só o apelido e se está conectado; null nas salas sem sessão. */
  owner: { nickname: string; online: boolean } | null;
  /** As músicas da sala estão no computador do dono: sem prévia do instrumental no celular. */
  local_media: boolean;
  queue: QueueItem[];
  me: { is_host: boolean; pid: string | null };
  /** Quem está na sala agora (para convidar para um dueto): nome e uma identificação que não revela o client_id. */
  people: { pid: string; name: string }[];
}

/** Uma linha da letra sincronizada (lyrics.json). `words` = [início, fim] de cada palavra, quando houve alinhamento. */
export interface LyricCue {
  start: number;
  end: number;
  text: string;
  words?: [number, number][];
}

/** Mensagens que o servidor envia pelo WebSocket da sala. */
export type ServerMessage =
  | { type: 'state'; state: RoomState }
  | { type: 'position'; item_id: number; ms: number }
  | { type: 'lyrics'; item_id: number; cues: LyricCue[] }
  | { type: 'seek'; item_id: number; seconds?: number; to?: number };

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
