// Estado da sala em tempo real (WebSocket com reconexão) e a posição da música que a TV informa.
import { useCallback, useEffect, useRef, useState } from 'react';
import { connectRoom } from '../lib/identity.js';
import type { RoomState, ServerMessage } from '../lib/types';

export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting';

export interface Position {
  ms: number;
  /** `performance.now()` do instante em que `ms` foi informado (a barra de progresso anda sozinha a partir dele). */
  at: number;
  itemId: number | null;
}

export function useRoomConnection(code: string) {
  const [state, setState] = useState<RoomState | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [gone, setGone] = useState(false);
  const [position, setPosition] = useState<Position>({ ms: 0, at: performance.now(), itemId: null });
  const connectionRef = useRef<{ send(payload: unknown): void } | null>(null);
  /** Manda uma mensagem à sala pelo WebSocket (ex.: o nome da pessoa). */
  const send = useCallback((payload: unknown) => connectionRef.current?.send(payload), []);

  useEffect(() => {
    const connection = connectRoom(code, 'controller', {
      onMessage(message: ServerMessage) {
        if (message.type === 'state') {
          setState(message.state);
          setPosition({ ms: message.state.position_ms, at: performance.now(), itemId: message.state.current_item_id });
        } else if (message.type === 'position') {
          setPosition({ ms: message.ms, at: performance.now(), itemId: message.item_id });
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

  return { state, setState, status, gone, position, send };
}
