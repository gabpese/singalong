// Contexto da sala (celular): o código, o estado, as ações e os avisos, compartilhados pelos componentes.
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/identity.js';
import type { ApiError, RoomState } from '../lib/types';

export type Tab = 'queue' | 'add' | 'library';

export interface RoomContextValue {
  code: string;
  state: RoomState | null;
  isHost: boolean;
  /** Ação na sala; o estado devolvido já atualiza a tela (o WebSocket confirma para todos). Lança em caso de erro (já avisado). */
  act: (method: string, path: string, body?: unknown) => Promise<any>;
  toast: (text: string, isError?: boolean) => void;
  /** Nome que vai na fila: o digitado, ou "Alguém". */
  myName: string;
  showTab: (tab: Tab) => void;
}

const RoomContext = createContext<RoomContextValue | null>(null);

export function useRoom(): RoomContextValue {
  const value = useContext(RoomContext);
  if (!value) throw new Error('useRoom fora do RoomProvider');
  return value;
}

export const RoomProvider = RoomContext.Provider;

/** Aviso passageiro no rodapé (`<p class="toast show">`); some depois de 3,5 s. */
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

/** Faz uma ação na sala e atualiza o estado com a resposta; erros viram aviso e são relançados. */
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
