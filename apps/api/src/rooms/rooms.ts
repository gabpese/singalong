// Rooms and the Queue: the plain helpers and limits. The rules live in room.service.ts.
//
// Roles: the "TV" (the browser that plays: it owns the position and the "ended" event), "controller" (the phones) and the
// Host (who created the Room: skips, pauses, reorders and removes anyone's songs). Everyone else adds songs and removes or
// adjusts their own. Commands come over HTTP; the WebSocket only pushes the state and takes in the TV's events.
import { createHash, randomBytes } from 'node:crypto';
import type { LyricCue, QueueItem, RoomState } from '../protocol.ts';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O/1/I/L: easy to read out and type
export const MAX_QUEUE = 100;
export const MAX_PER_CLIENT = 20;
/** A browser's id (X-Client-Id, or `client` on the WebSocket). */
export const CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** Who sends a command: the browser's id (X-Client-Id) and, for the Host, the Room's token (X-Host-Token). */
export interface Actor {
  clientId: string;
  hostToken: string;
}

/** A person IN THE ROOM, for invitations: a digest of the client_id (which never leaves the server) that cannot be reversed. */
export const pidOf = (clientId: string) => createHash('sha256').update(`pessoa:${clientId}`).digest('hex').slice(0, 10);

/** The name the person typed (or "Alguém"), at the length the Queue takes. */
export const cleanName = (name: unknown) => String(name ?? '').trim().slice(0, 30) || 'Alguém';

export const normalizeCode = (code: unknown) => String(code ?? '').trim().toUpperCase();

export function generateCode(length = 4): string {
  const bytes = randomBytes(length);
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
}

/** The lyrics the TV hands to the Stage: only well-formed lines {start, end, text, words?} of a reasonable size (or null). */
export function sanitizeCues(cues: unknown): LyricCue[] | null {
  if (!Array.isArray(cues) || cues.length > 3000) return null;
  const clean: LyricCue[] = [];
  for (const cue of cues) {
    if (!Number.isFinite(cue?.start) || !Number.isFinite(cue?.end) || typeof cue?.text !== 'string' || cue.text.length > 400) return null;
    const words = Array.isArray(cue.words) && cue.words.length <= 120 && cue.words.every((w: unknown) => Array.isArray(w) && Number.isFinite(w[0]) && Number.isFinite(w[1]))
      ? cue.words.map((w: [number, number]) => [w[0], w[1]] as [number, number])
      : undefined;
    clean.push({ start: cue.start, end: cue.end, text: cue.text, ...(words ? { words } : {}) });
  }
  return JSON.stringify(clean).length <= 400_000 ? clean : null;
}

/** A Queue item before `personalize`: with its owner's and its guest's client_id, which never leave the server. */
export type BaseQueueItem = Omit<QueueItem, 'mine' | 'can_edit' | 'guest_me' | 'invite_for_me'> & { client_id: string; guest_client_id: string | null };

/** The Room's state before `personalize`, the same for everyone. */
export type BaseRoomState = Omit<RoomState, 'queue' | 'me'> & { queue: BaseQueueItem[] };

/** The state sent to ONE connection: nobody's client_id, with `mine` and `can_edit` on each item. */
export function personalize(base: BaseRoomState, { clientId, isHost }: { clientId: string; isHost: boolean }): RoomState {
  return {
    ...base,
    me: { is_host: Boolean(isHost), pid: clientId ? pidOf(clientId) : null },
    queue: base.queue.map(({ client_id: owner, guest_client_id: guestOwner, ...item }) => ({
      ...item,
      mine: owner === clientId,
      can_edit: Boolean(isHost) || owner === clientId,
      guest_me: Boolean(clientId) && guestOwner === clientId && item.guest?.status === 'accepted', // I sing along in this song
      invite_for_me: Boolean(clientId) && guestOwner === clientId && item.guest?.status === 'pending', // I was invited: accept or decline
    })),
  };
}
