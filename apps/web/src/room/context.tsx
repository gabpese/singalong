// The Room's context (phone): the code, the state, the actions and the notices, shared by the components.
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/identity.ts';
import type { ApiError, LyricCue, QueueItem, ReactionKind, RoomState } from '../lib/types.ts';

export type Tab = 'queue' | 'add' | 'library';
/** The Room's two views: the Room (Queue, add, songs) and the TV (the lyrics and the Queue, only to watch). */
export type View = 'room' | 'tv';

export interface RoomContextValue {
  code: string;
  state: RoomState | null;
  isHost: boolean;
  /** An action in the Room; the returned state updates the screen at once (the WebSocket confirms it for everyone). Throws on an error (already shown). */
  act: (method: string, path: string, body?: unknown) => Promise<any>;
  toast: (text: string, isError?: boolean) => void;
  /** The name that goes in the Queue: the one typed, or "Alguém". */
  myName: string;
  showTab: (tab: Tab) => void;
  /** Sends a Reaction (applause, fire...) to the TV. */
  react: (kind: ReactionKind) => void;
  /** The lyrics of a song in the Queue (from the server or, on the Owner's computer, the ones the TV relayed); null if out of reach. */
  loadCues: (item: QueueItem) => Promise<LyricCue[] | null>;
}

const RoomContext = createContext<RoomContextValue | null>(null);

export function useRoom(): RoomContextValue {
  const value = useContext(RoomContext);
  if (!value) throw new Error('useRoom fora do RoomProvider');
  return value;
}

export const RoomProvider = RoomContext.Provider;

/** A passing notice in the footer (`<p class="toast show">`); goes away after 3.5 s. */
export function useToast() {
  const [toast, setToast] = useState({ text: '', isError: false, show: false });
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = useCallback((text: string, isError = false) => {
    clearTimeout(timer.current);
    setToast({ text, isError, show: true });
    timer.current = setTimeout(() => setToast((current) => ({ ...current, show: false })), 3500);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  return { toast, show };
}

/** Does an action in the Room and updates the state with the answer; errors become a notice and are rethrown. */
export function useAct(code: string, setState: (state: RoomState) => void, toast: (text: string, isError?: boolean) => void) {
  return useMemo(
    () => async (method: string, path: string, body?: unknown) => {
      try {
        const result = await api(method, `/api/rooms/${code}${path}`, body, code);
        if (result.state?.queue) setState(result.state);
        return result;
      } catch (err) {
        toast((err as ApiError).message, true);
        throw err;
      }
    },
    [code, setState, toast],
  );
}
