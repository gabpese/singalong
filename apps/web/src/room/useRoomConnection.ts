// Estado da sala em tempo real (WebSocket com reconexão) e a posição da música que a TV informa.
import { useCallback, useEffect, useRef, useState } from 'react';
import { connectRoom } from '../lib/identity.ts';
import type { ClientMessage, LyricCue, ReactionKind, RoomState, ServerMessage } from '../lib/types.ts';

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting';

export interface Position {
  ms: number;
  /** `performance.now()` do instante em que `ms` foi informado (a barra de progresso anda sozinha a partir dele). */
  at: number;
  itemId: number | null;
}

export function useRoomConnection(code: string, onReaction?: (kind: ReactionKind, name?: string) => void) {
  const [state, setState] = useState<RoomState | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [gone, setGone] = useState(false);
  const [position, setPosition] = useState<Position>({ ms: 0, at: performance.now(), itemId: null });
  /** A letra da música atual, repassada pela TV (a aba TV da sala desenha com ela). */
  const [lyrics, setLyrics] = useState<{ itemId: number; cues: LyricCue[] } | null>(null);
  const connectionRef = useRef<{ send(message: ClientMessage): void } | null>(null);
  const reactionRef = useRef(onReaction); // sempre a versão mais recente, sem reabrir o WebSocket
  reactionRef.current = onReaction;
  /** Manda uma mensagem à sala pelo WebSocket (ex.: o nome da pessoa). */
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
