// The shapes the server sends and takes are defined by the API (apps/api/src/protocol.ts). This module passes them on as types
// only, so nothing of the API reaches the bundle. The web's own types stay here.
export type {
  AddedSong,
  ClientMessage,
  CreatedRoom,
  Download,
  ExportState,
  Guest,
  Interlude,
  LibrarySong,
  LyricCue,
  Playback,
  PublicConfig,
  QueueItem,
  ReactionKind,
  RoomState,
  ScoreRow,
  SearchResult,
  ServerMessage,
  SongKey,
  SongMedia,
  SongView,
} from '../../../api/src/protocol.ts';

/** An API call that failed: the HTTP status and the error code the server sent. */
export interface ApiError extends Error {
  status?: number;
  code?: string;
}
