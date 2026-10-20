import type { Bucket } from './reactions.ts';
import { cleanName } from './rooms.ts';

/** What a Room needs of a WebSocket: the `ws` library's, or a test's stand-in. */
export interface RoomSocket {
  readonly readyState: number;
  send(data: string): void;
  ping(): void;
  terminate(): void;
}

/** One device connected to a Room. */
export interface Connection {
  socket: RoomSocket;
  /** The Room's code, normalized. */
  code: string;
  role: 'tv' | 'controller';
  clientId: string;
  name: string;
  isHost: boolean;
  /** It answered the last ping (a TV switched off without closing its socket does not). */
  alive: boolean;
  /** The limit on its Reactions. */
  reactions: Bucket;
}

const OPEN = 1;

/**
 * The WebSocket connections of each Room. The state lives in one process (this hub in memory); with several API replicas,
 * it would move to Redis pub/sub.
 */
export class Hub {
  private readonly rooms = new Map<string, Set<Connection>>();

  /** Adds the connection; returns the function that removes it. */
  add(conn: Connection): () => void {
    if (!this.rooms.has(conn.code)) this.rooms.set(conn.code, new Set());
    this.rooms.get(conn.code)!.add(conn);
    return () => {
      this.rooms.get(conn.code)?.delete(conn);
      if (!this.rooms.get(conn.code)?.size) this.rooms.delete(conn.code);
    };
  }

  count(code: string, role: Connection['role']): number {
    return [...(this.rooms.get(code) ?? [])].filter((conn) => conn.role === role).length;
  }

  /** The phones connected now, one entry per person (the same client_id in two tabs counts once). */
  people(code: string): { clientId: string; name: string }[] {
    const byClient = new Map<string, { clientId: string; name: string }>();
    for (const conn of this.rooms.get(code) ?? []) {
      if (conn.role === 'controller' && conn.clientId) byClient.set(conn.clientId, { clientId: conn.clientId, name: cleanName(conn.name) });
    }
    return [...byClient.values()];
  }

  codes(): string[] {
    return [...this.rooms.keys()];
  }

  /** `build(conn)` returns what to send to that connection (or null to skip it). */
  broadcast(code: string, build: (conn: Connection) => object | null): void {
    for (const conn of this.rooms.get(code) ?? []) {
      const payload = build(conn);
      if (payload && conn.socket.readyState === OPEN) conn.socket.send(JSON.stringify(payload));
    }
  }

  /** Drops the connections that did not answer the previous ping (a TV switched off without closing its socket). */
  heartbeat(): void {
    for (const conns of this.rooms.values()) {
      for (const conn of conns) {
        if (conn.alive === false) {
          conn.socket.terminate();
          continue;
        }
        conn.alive = false;
        conn.socket.ping();
      }
    }
  }

  /** Closes every connection (the API is shutting down). */
  closeAll(): void {
    for (const conns of this.rooms.values()) for (const conn of conns) conn.socket.terminate();
    this.rooms.clear();
  }
}
