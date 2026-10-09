// Identidade do navegador, token de anfitrião e chamadas à API (compartilhado por entrada, controle e TV).

const memory = new Map(); // se o localStorage estiver bloqueado, vale só enquanto a página estiver aberta
const store = {
  get(key) {
    try {
      return localStorage.getItem(key) ?? memory.get(key) ?? null;
    } catch {
      return memory.get(key) ?? null;
    }
  },
  set(key, value) {
    memory.set(key, value);
    try {
      localStorage.setItem(key, value);
    } catch {
      // sem armazenamento: fica só na memória
    }
  },
};

/** ID aleatório do navegador. Não usa crypto.randomUUID: ele não existe em páginas http fora de localhost. */
export function newClientId(getRandomValues = (bytes) => crypto.getRandomValues(bytes)) {
  const bytes = getRandomValues(new Uint8Array(12));
  return `c${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function clientId() {
  let id = store.get('clientId');
  if (!id) {
    id = newClientId();
    store.set('clientId', id);
  }
  return id;
}

export const userName = () => store.get('userName') ?? '';
export const setUserName = (name) => store.set('userName', name.trim().slice(0, 30));

/** Código da sala em `?room=ABCD` (maiúsculas), ou null. */
export function parseRoomCode(search) {
  const code = new URLSearchParams(search).get('room')?.trim().toUpperCase();
  return code && /^[A-Z0-9]{4,8}$/.test(code) ? code : null;
}

/** Token de anfitrião em `#host=TOKEN` (link de anfitrião), ou null. */
export function parseHostHash(hash) {
  return /(?:^#|&)host=([A-Za-z0-9]+)/.exec(hash)?.[1] ?? null;
}

export const hostToken = (code) => store.get(`host:${code}`) ?? '';
export const setHostToken = (code, token) => store.set(`host:${code}`, token);

export function authHeaders(code) {
  const token = code ? hostToken(code) : '';
  return { 'x-client-id': clientId(), ...(token ? { 'x-host-token': token } : {}) };
}

/** Chamada JSON à API; em erro lança Error(message amigável) com `.status` e `.code`. */
export async function api(method, path, body, code) {
  const res = await fetch(path, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...authHeaders(code) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.message ?? data.error ?? `Erro ${res.status}`);
    error.status = res.status;
    error.code = data.error;
    throw error;
  }
  return data;
}

/** Endereço do WebSocket da sala (ws:// ou wss:// conforme a página). */
export function roomSocketUrl(code, role) {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const host = role === 'controller' ? hostToken(code) : '';
  return `${scheme}://${location.host}/api/rooms/${code}/ws?role=${role}&client=${clientId()}${host ? `&host=${host}` : ''}`;
}

/**
 * WebSocket que reconecta sozinho (TV desligou o Wi-Fi, API reiniciou...).
 * `onClose(code)` com 1008 = sala inexistente: não tenta de novo.
 */
export function connectRoom(code, role, { onMessage, onStatus, onGone }) {
  let socket;
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
        // mensagem inválida: ignora
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
    send: (payload) => socket?.readyState === 1 && socket.send(JSON.stringify(payload)),
    close() {
      closed = true;
      socket?.close();
    },
  };
}
