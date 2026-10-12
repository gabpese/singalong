// Apoio dos testes: criar sala e músicas pela API, como os celulares fazem.
import { expect } from '@playwright/test';

export const SONGS = {
  alpha: { id: 'songAlpha01', title: 'Wicked Game', artist: 'Stone Sour' },
  bravo: { id: 'songBravo02', title: 'Unethical', artist: 'Faouzia' },
  charlie: { id: 'songCharl03', title: 'Rolling in the Deep', artist: 'Adele' },
  delta: { id: 'songDelta04', title: 'Unethical (Acoustic)', artist: 'Faouzia' },
};

export const ANA = 'client-ana-0001';
export const BIA = 'client-bia-0001';

export async function createRoom(request) {
  const res = await request.post('/api/rooms');
  expect(res.status()).toBe(201);
  const { code, host_token: host } = await res.json();
  return { code, host, hostUrl: `/room.html?room=${code}#host=${host}`, guestUrl: `/room.html?room=${code}`, tvUrl: `/tv.html?room=${code}` };
}

/** Põe uma música pronta na fila como `client` (cada client é uma pessoa diferente). */
export async function addToQueue(request, code, song, { client = ANA, name = 'Ana', pitch } = {}) {
  const res = await request.post(`/api/rooms/${code}/queue`, {
    headers: { 'x-client-id': client },
    data: { video_id: song.id, name, display_title: song.title, ...(pitch === undefined ? {} : { pitch }) },
  });
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()).item_id;
}

export async function roomState(request, code, { host, client = ANA } = {}) {
  const res = await request.get(`/api/rooms/${code}`, { headers: { 'x-client-id': client, ...(host ? { 'x-host-token': host } : {}) } });
  return res.json();
}

export const hostPatch = (request, room, body) =>
  request.patch(`/api/rooms/${room.code}`, { headers: { 'x-client-id': ANA, 'x-host-token': room.host }, data: body });

const ADMIN = { 'x-admin-token': 'e2e-admin' };

/** Faz o papel do app do dono: pareia um dispositivo, inicia a sessão (com o servidor local de mídia, se `mediaBase`) e cria uma sala nela. */
export async function startAgentSession(request, nickname, mediaBase = null) {
  const { code } = await (await request.post('/agent/v1/pair/start', { headers: ADMIN, data: {} })).json();
  const { token } = await (await request.post('/agent/v1/pair/complete', { data: { code, name: 'PC do teste' } })).json();
  const headers = { authorization: `Bearer ${token}` };
  const sessionRes = await request.post('/agent/v1/sessions', { headers, data: { display_name: nickname, ...(mediaBase ? { media_base: mediaBase } : {}) } });
  expect(sessionRes.status(), await sessionRes.text()).toBe(201);
  const session = await sessionRes.json();
  const room = await (await request.post(`/agent/v1/sessions/${session.id}/rooms`, { headers, data: {} })).json();
  return { headers, session, room, tvUrl: `/tv.html?room=${room.code}`, guestUrl: `/room.html?room=${room.code}` };
}

/** Publica no catálogo do dono uma música que "está no computador dele". */
export async function publishLocalSong(request, headers, song, files = {}) {
  const res = await request.put('/agent/v1/library', {
    headers,
    data: { songs: [{ id: song.id, meta: { video_id: song.id, title: song.title, artist: song.artist, duration: 30, lyrics_source: 'lrclib' }, files: { instrumental: true, lyrics: true, melody: false, backing: false, exports: [], ...files } }] },
  });
  expect(res.status(), await res.text()).toBe(200);
}
