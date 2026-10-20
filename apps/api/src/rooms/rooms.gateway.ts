import type { IncomingMessage } from 'node:http';
import { ConnectedSocket, MessageBody, type OnGatewayConnection, type OnGatewayDisconnect, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';
import type { ClientMessage } from '../protocol.ts';
import type { Connection, RoomSocket } from './hub.ts';
import { RoomService } from './room.service.ts';
import { CLIENT_ID } from './rooms.ts';

/** A device's socket (the `ws` library's); `joined` settles once it joined its Room (null when the Room does not exist). */
type RoomClient = RoomSocket & {
  close(code?: number, reason?: string): void;
  on(event: 'pong', listener: () => void): void;
  joined?: Promise<Awaited<ReturnType<RoomService['connect']>> | null>;
};

/** A TV message about a Queue item, as it arrives: any field may be missing or of another type (see ClientMessage). */
interface TvMessage {
  item_id?: unknown;
  score?: unknown;
  ms?: unknown;
  cues?: unknown;
}

/**
 * The devices' messages keep the protocol's own shape, `{ type, ... }`: this hands them to Nest as `{ event: type, data }`.
 * Anything else (not JSON, no type) is dropped.
 */
export function parseRoomMessage(data: unknown): { event: string; data: Record<string, unknown> } | undefined {
  try {
    const message = JSON.parse(String(data));
    return message && typeof message === 'object' && typeof message.type === 'string' ? { event: message.type, data: message } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The Room's real-time channel: one WebSocket per device at `/api/rooms/ws?code=…&role=tv|controller&client=…&host=…&name=…`.
 * The server pushes the state; the phones send their name and Reactions, and the TV the song's position, lyrics, Score and end.
 * A handler resolves once the Room has dealt with the message; a failure is dropped, as a broken message would be.
 */
@WebSocketGateway({ path: '/api/rooms/ws', maxPayload: 1024 * 1024 })
export class RoomsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  constructor(private readonly rooms: RoomService) {}

  handleConnection(socket: RoomClient, request: IncomingMessage) {
    const query = new URL(request.url ?? '/', 'http://localhost').searchParams;
    const client = query.get('client') ?? '';
    socket.joined = this.rooms
      .connect(query.get('code') ?? '', { socket, role: query.get('role'), clientId: CLIENT_ID.test(client) ? client : '', hostToken: query.get('host'), name: query.get('name') })
      .then((session) => {
        socket.on('pong', () => {
          session.conn.alive = true;
        });
        return session;
      })
      .catch(() => {
        socket.close(1008, 'room_not_found');
        return null;
      });
  }

  async handleDisconnect(socket: RoomClient) {
    (await socket.joined)?.leave();
  }

  /** The connection behind a socket, once it joined its Room. */
  private async connOf(socket: RoomClient): Promise<Connection | null> {
    return (await socket.joined)?.conn ?? null;
  }

  /** The TV's connection, when the message comes from a TV and names an item; the phones do not send these. */
  private async tvOf(socket: RoomClient, message: TvMessage): Promise<Connection | null> {
    const conn = await this.connOf(socket);
    return conn?.role === 'tv' && Number.isInteger(message.item_id) ? conn : null;
  }

  /** The phone says the person's name (for the list of who is in the Room). */
  @SubscribeMessage('hello' satisfies ClientMessage['type'])
  async hello(@ConnectedSocket() socket: RoomClient, @MessageBody() message: { name?: unknown }) {
    const conn = await this.connOf(socket);
    if (conn) this.rooms.rename(conn, message.name);
  }

  @SubscribeMessage('reaction' satisfies ClientMessage['type'])
  async reaction(@ConnectedSocket() socket: RoomClient, @MessageBody() message: { kind?: unknown }) {
    const conn = await this.connOf(socket);
    if (conn) await this.rooms.react(conn, message.kind).catch(() => {});
  }

  @SubscribeMessage('ended' satisfies ClientMessage['type'])
  async ended(@ConnectedSocket() socket: RoomClient, @MessageBody() message: TvMessage) {
    const tv = await this.tvOf(socket, message);
    if (tv) await this.rooms.tvEnded(tv.code, message.item_id as number).catch(() => {});
  }

  @SubscribeMessage('score' satisfies ClientMessage['type'])
  async score(@ConnectedSocket() socket: RoomClient, @MessageBody() message: TvMessage) {
    const tv = await this.tvOf(socket, message);
    if (tv) await this.rooms.tvScore(tv.code, message.item_id as number, message.score as number).catch(() => {});
  }

  @SubscribeMessage('position' satisfies ClientMessage['type'])
  async position(@ConnectedSocket() socket: RoomClient, @MessageBody() message: TvMessage) {
    const tv = await this.tvOf(socket, message);
    if (tv && Number.isFinite(message.ms)) this.rooms.tvPosition(tv.code, message.item_id as number, message.ms as number);
  }

  @SubscribeMessage('lyrics' satisfies ClientMessage['type'])
  async lyrics(@ConnectedSocket() socket: RoomClient, @MessageBody() message: TvMessage) {
    const tv = await this.tvOf(socket, message);
    if (tv) await this.rooms.tvLyrics(tv.code, message.item_id as number, message.cues).catch(() => {});
  }
}
