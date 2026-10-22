// The Room's state in real time (a WebSocket that reconnects) and the song's position that the TV reports.
import { useCallback, useEffect, useRef, useState } from 'react';
import { connectRoom } from '../lib/identity.ts';
import type { ClientMessage, LyricCue, ReactionKind, RoomState, ServerMessage } from '../lib/types.ts';

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting';

export interface Position {
  ms: number;
  /** The `performance.now()` of the instant `ms` was reported (the progress bar runs on its own from it). */
  at: number;
  itemId: number | null;
}

export function useRoomConnection(code: string, onReaction?: (kind: ReactionKind, name?: string) => void) {
  const [state, setState] = useState<RoomState | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [gone, setGone] = useState(false);
  const [position, setPosition] = useState<Position>({ ms: 0, at: performance.now(), itemId: null });
  /** The current song's lyrics, relayed by the TV (the Room's TV tab draws with them). */
  const [lyrics, setLyrics] = useState<{ itemId: number; cues: LyricCue[] } | null>(null);
  const connectionRef = useRef<{ send(message: ClientMessage): void } | null>(null);
  const reactionRef = useRef(onReaction); // always the latest version, without reopening the WebSocket
  reactionRef.current = onReaction;
  /** Sends a message to the Room through the WebSocket (e.g. the person's name). */
  const send = useCallback((message: ClientMessage) => connectionRef.current?.send(message), []);

  useEffect(() => {
    const connection = connectRoom(code, 'controller', {
      onMessage(message: ServerMessage) {
        if (message.type === 'state') {
          setState(message.state);
          setPosition({ ms: message.state.position_ms, at: performance.now(), itemId: message.state.current_item_id });
        } else if (message.type === 'position') {
          setPosition({ ms: message.ms, at: performance.now(), itemId: message.item_id });
        } else if (message.type === 'lyrics') {
          setLyrics({ itemId: message.item_id, cues: message.cues });
        } else if (message.type === 'reaction') {
          reactionRef.current?.(message.kind, message.name);
        }
      },
      onStatus(next: string) {
        setStatus(next === 'connected' ? 'connected' : 'reconnecting');
      },
      onGone() {
        setGone(true);
      },
    });
    connectionRef.current = connection;
    return () => {
      connectionRef.current = null;
      connection.close();
    };
  }, [code]);

  return { state, setState, status, gone, position, lyrics, send };
}
