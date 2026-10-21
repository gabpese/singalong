// The tests' helpers: creating Rooms and songs through the API, as the phones do.
import axe from '@axe-core/playwright';
import { type APIRequestContext, expect } from '@playwright/test';
import type { RoomState } from '../src/lib/types.ts';

export interface TestSong {
  id: string;
  title: string;
  artist: string;
}

export const SONGS = {
  alpha: { id: 'songAlpha01', title: 'Wicked Game', artist: 'Stone Sour' },
  bravo: { id: 'songBravo02', title: 'Unethical', artist: 'Faouzia' },
  charlie: { id: 'songCharl03', title: 'Rolling in the Deep', artist: 'Adele' },
  delta: { id: 'songDelta04', title: 'Unethical (Acoustic)', artist: 'Faouzia' },
} satisfies Record<string, TestSong>;

/**
 * axe's builder. The package's types describe only its CommonJS build, so under nodenext its default import reads as the whole
 * module; the ESM build that Playwright loads exports the class itself.
 */
export const AxeBuilder = axe as unknown as typeof axe.default;

export const ANA = 'client-ana-0001';
export const BIA = 'client-bia-0001';

export interface TestRoom {
  code: string;
  host: string;
  hostUrl: string;
  guestUrl: string;
  tvUrl: string;
}

export async function createRoom(request: APIRequestContext): Promise<TestRoom> {
  const res = await request.post('/api/rooms');
  expect(res.status()).toBe(201);
  const { code, host_token: host } = await res.json();
  return { code, host, hostUrl: `/room.html?room=${code}#host=${host}`, guestUrl: `/room.html?room=${code}`, tvUrl: `/tv.html?room=${code}` };
}

/** Puts a ready song in the Queue as `client` (each client is a different person). */
export async function addToQueue(request: APIRequestContext, code: string, song: TestSong, { client = ANA, name = 'Ana', pitch }: { client?: string; name?: string; pitch?: number } = {}): Promise<number> {
  const res = await request.post(`/api/rooms/${code}/queue`, {
    headers: { 'x-client-id': client },
    data: { video_id: song.id, name, display_title: song.title, ...(pitch === undefined ? {} : { pitch }) },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).item_id;
}

export async function roomState(request: APIRequestContext, code: string, { host, client = ANA }: { host?: string; client?: string } = {}): Promise<RoomState> {
  const res = await request.get(`/api/rooms/${code}`, { headers: { 'x-client-id': client, ...(host ? { 'x-host-token': host } : {}) } });
  return res.json();
}

export const hostPatch = (request: APIRequestContext, room: TestRoom, body: Record<string, unknown>) =>
  request.patch(`/api/rooms/${room.code}`, { headers: { 'x-client-id': ANA, 'x-host-token': room.host }, data: body });

const ADMIN = { 'x-admin-token': 'e2e-admin' };

/** Plays the owner's app: pairs a device, starts the Session (with the local media server, given `mediaBase`) and creates a Room in it. */
export async function startAgentSession(request: APIRequestContext, nickname: string, mediaBase: string | null = null) {
  const { code } = await (await request.post('/agent/v1/pair/start', { headers: ADMIN, data: {} })).json();
  const { token } = await (await request.post('/agent/v1/pair/complete', { data: { code, name: 'Test PC' } })).json();
  const headers = { authorization: `Bearer ${token}` };
  const sessionRes = await request.post('/agent/v1/sessions', { headers, data: { display_name: nickname, ...(mediaBase ? { media_base: mediaBase } : {}) } });
  expect(sessionRes.status(), await sessionRes.text()).toBe(201);
  const session: { id: string } = await sessionRes.json();
  const room: { code: string; host_token: string } = await (await request.post(`/agent/v1/sessions/${session.id}/rooms`, { headers, data: {} })).json();
  return { headers, session, room, tvUrl: `/tv.html?room=${room.code}`, guestUrl: `/room.html?room=${room.code}` };
}

/** Publishes to the owner's catalog a song that "is on their computer". */
export async function publishLocalSong(request: APIRequestContext, headers: Record<string, string>, song: TestSong, files: Record<string, unknown> = {}) {
  const res = await request.put('/agent/v1/library', {
    headers,
    data: { songs: [{ id: song.id, meta: { video_id: song.id, title: song.title, artist: song.artist, duration: 30, lyrics_source: 'lrclib' }, files: { instrumental: true, lyrics: true, melody: false, backing: false, exports: [], ...files } }] },
  });
  expect(res.status(), await res.text()).toBe(200);
}
