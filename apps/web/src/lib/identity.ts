// The browser's identity, the Host token and API calls (shared by the landing page, the phone and the TV).
import { hasText, t } from '../i18n/index.ts';
import type { ApiError, ServerMessage } from './types.ts';

export type SocketRole = 'tv' | 'controller';

const memory = new Map<string, string>(); // if localStorage is blocked, it only lasts while the page is open
const store = {
  get(key: string): string | null {
    try {
      return localStorage.getItem(key) ?? memory.get(key) ?? null;
    } catch {
      return memory.get(key) ?? null;
    }
  },
  set(key: string, value: string): void {
    memory.set(key, value);
    try {
      localStorage.setItem(key, value);
    } catch {
      // no storage: it stays in memory only
    }
  },
};

/** A random ID for the browser. It does not use crypto.randomUUID: that does not exist on http pages outside localhost. */
export function newClientId(
  getRandomValues: (bytes: Uint8Array<ArrayBuffer>) => Uint8Array = (bytes) => crypto.getRandomValues(bytes),
): string {
  const bytes = getRandomValues(new Uint8Array(12));
  return `c${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function clientId(): string {
  let id = store.get('clientId');
  if (!id) {
    id = newClientId();
    store.set('clientId', id);
  }
  return id;
}

export const userName = (): string => store.get('userName') ?? '';
export const setUserName = (name: string): void => store.set('userName', name.trim().slice(0, 30));

/** The Room code in `?room=ABCD` (uppercase), or null. */
export function parseRoomCode(search: string): string | null {
  const code = new URLSearchParams(search).get('room')?.trim().toUpperCase();
  return code && /^[A-Z0-9]{4,8}$/.test(code) ? code : null;
}

/** The Host token in `#host=TOKEN` (the Host link), or null. */
export function parseHostHash(hash: string): string | null {
  return /(?:^#|&)host=([A-Za-z0-9]+)/.exec(hash)?.[1] ?? null;
}

export const hostToken = (code: string): string => store.get(`host:${code}`) ?? '';
export const setHostToken = (code: string, token: string): void => store.set(`host:${code}`, token);

export function authHeaders(code?: string | null): Record<string, string> {
  const token = code ? hostToken(code) : '';
  // x-room says which Room the request comes from: with a local agent, the owner of its Session answers the search, the lyrics and the MP4
  return { 'x-client-id': clientId(), ...(token ? { 'x-host-token': token } : {}), ...(code ? { 'x-room': code } : {}) };
}

/**
 * A JSON call to the API; on error it throws an Error (a friendly message) with `.status` and `.code`.
 * The caller names the response's type; the default stays `any` until the API publishes its types (ROADMAP, step 3).
 */
export async function api<T = any>(method: string, path: string, body?: unknown, code?: string | null): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...authHeaders(code) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // the server sends a code (`error`) and the message in Portuguese: when the code has a translation, the person's language wins
    const known = data.error && hasText(`apierr.${data.error}`) ? t(`apierr.${data.error}`) : null;
    const error: ApiError = new Error(known ?? data.message ?? data.error ?? t('error.http', { status: res.status }));
    error.status = res.status;
    error.code = data.error;
    throw error;
  }
  return data;
}

/** The Room's WebSocket address (ws:// or wss:// depending on the page). */
export function roomSocketUrl(code: string, role: SocketRole): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const host = role === 'controller' ? hostToken(code) : '';
  const name = role === 'controller' && userName() ? `&name=${encodeURIComponent(userName())}` : '';
  return `${scheme}://${location.host}/api/rooms/${code}/ws?role=${role}&client=${clientId()}${host ? `&host=${host}` : ''}${name}`;
}

/** A WebSocket that reconnects by itself (the TV dropped the Wi-Fi, the API restarted...). A close with 1008 = the Room does not exist: no retry. */
export function connectRoom(
  code: string,
  role: SocketRole,
  { onMessage, onStatus, onGone }: { onMessage: (message: ServerMessage) => void; onStatus?: (status: 'connected' | 'reconnecting') => void; onGone?: () => void },
): { send(payload: unknown): void; close(): void } {
  let socket: WebSocket | undefined;
  let attempt = 0;
  let closed = false;
  const open = () => {
    socket = new WebSocket(roomSocketUrl(code, role));
    socket.addEventListener('open', () => {
      attempt = 0;
      onStatus?.('connected');
    });
    socket.addEventListener('message', (event) => {
      try {
        onMessage(JSON.parse(event.data));
      } catch {
        // an invalid message: ignore it
      }
    });
    socket.addEventListener('close', (event) => {
      if (closed) return;
      if (event.code === 1008) return onGone?.();
      onStatus?.('reconnecting');
      setTimeout(open, Math.min(1000 * 2 ** attempt++, 10_000));
    });
  };
  open();
  return {
    send: (payload) => {
      if (socket?.readyState === 1) socket.send(JSON.stringify(payload));
    },
    close() {
      closed = true;
      socket?.close();
    },
  };
}
