// Local storage: the song is on the owner's computer. The cloud knows only the catalog the agent publishes; the TV fetches the
// audio and the lyrics from the local media server (another origin, with CORS and Range), as the owner's app would serve them.
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { ANA, publishLocalSong, startAgentSession, type TestSong } from './helpers.ts';

type MediaLog = { url: string; origin?: string }[];

const MEDIA_BASE = 'http://127.0.0.1:3101/e2e';
// a song the cloud does NOT have in its storage as "ready" for this Room: only the owner's catalog knows it
const LOCAL = { id: 'localSong01', title: 'Tempo Perdido', artist: 'Legião Urbana' };

async function seedOnOwnersComputer(request: APIRequestContext, song: TestSong) {
  // "writes the files" in the folder the local media server serves (in the test, the same test folder)
  await request.post('/__test/seed-song', { data: song });
}

const playing = (page: Page) => page.evaluate(() => window.tv.engine.playing && window.tv.engine.duration > 0 && window.tv.engine.currentTime > 0);
const mediaLog = async (request: APIRequestContext): Promise<MediaLog> => (await request.get('/__test/media-log')).json();

test.beforeEach(async ({ request }) => {
  await request.delete('/__test/media-log');
});

test.afterEach(async ({ request }) => {
  await request.post('/__test/remove-song', { data: { id: LOCAL.id } });
});

test("the TV plays the song that is on the owner's computer, fetching it from the local media server", async ({ page, request }) => {
  await seedOnOwnersComputer(request, LOCAL);
  const { headers, room, tvUrl } = await startAgentSession(request, 'Dona Flor', MEDIA_BASE);
  await publishLocalSong(request, headers, LOCAL);
  const added = await request.post(`/api/rooms/${room.code}/queue`, { headers: { 'x-client-id': ANA }, data: { video_id: LOCAL.id, name: 'Ana' } });
  expect(added.status(), await added.text()).toBe(201);

  // the Room describes the song by the local server's addresses, and says the media is local
  const state = await (await request.get(`/api/rooms/${room.code}`, { headers: { 'x-client-id': ANA } })).json();
  expect(state.local_media).toBe(true);
  expect(state.queue[0].song.media).toMatchObject({ instrumental: `${MEDIA_BASE}/cache/${LOCAL.id}/instrumental.mp3`, local: true });

  await page.goto(tvUrl);
  await expect(page.locator('.singer.is-now')).toContainText('Ana');
  await expect.poll(() => playing(page)).toBe(true);
  await expect(page.locator('.line.current')).toContainText('Primeira linha da letra');
  await expect(page.getByRole('alert')).toBeHidden(); // all good: no notice

  // the audio, the lyrics and the probe came from the local server, from another origin (with CORS), not from the Room's server
  const log = await mediaLog(request);
  const urls = log.map((entry) => entry.url);
  expect(urls).toContain('/e2e/ping');
  expect(urls).toContain(`/e2e/cache/${LOCAL.id}/instrumental.mp3`);
  expect(urls).toContain(`/e2e/cache/${LOCAL.id}/lyrics.json`);
  expect(log.find((entry) => entry.url.endsWith('instrumental.mp3'))?.origin).toBe('http://127.0.0.1:3100');
});

test("the phone does not offer the instrumental's preview of a song that is on the owner's computer", async ({ page, request }) => {
  await seedOnOwnersComputer(request, LOCAL);
  const { headers, room, guestUrl } = await startAgentSession(request, 'Seu Zé', MEDIA_BASE);
  await publishLocalSong(request, headers, LOCAL);
  await request.post(`/api/rooms/${room.code}/queue`, { headers: { 'x-client-id': ANA }, data: { video_id: LOCAL.id, name: 'Ana' } });

  await page.goto(guestUrl);
  await expect(page.getByText('Tempo Perdido').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Prévia' })).toHaveCount(0);
});

test('when the browser cannot reach the local media server, the TV explains what to do', async ({ page, request }) => {
  await seedOnOwnersComputer(request, LOCAL);
  const { headers, room, tvUrl } = await startAgentSession(request, 'Dona Flor', 'http://127.0.0.1:3199/e2e'); // nobody listens on that port
  await publishLocalSong(request, headers, LOCAL);
  await request.post(`/api/rooms/${room.code}/queue`, { headers: { 'x-client-id': ANA }, data: { video_id: LOCAL.id, name: 'Ana' } });

  await page.goto(tvUrl);
  await expect(page.getByRole('alert')).toContainText('O navegador bloqueou o acesso às músicas deste computador');
  await expect(page.getByRole('alert')).toContainText('rede local');
});

test('without a local song in the Room the TV neither checks nor warns anything', async ({ page, request }) => {
  const { room, tvUrl } = await startAgentSession(request, 'Dona Flor', MEDIA_BASE);
  expect((await (await request.get(`/api/rooms/${room.code}`, { headers: { 'x-client-id': ANA } })).json()).local_media).toBe(true); // the Session is local...
  await page.goto(tvUrl);
  await expect(page.getByText(`Entre na sala ${room.code} pelo celular`)).toBeVisible();
  await expect(page.getByRole('alert')).toBeHidden();
  const log = await mediaLog(request);
  expect(log.filter((entry) => entry.url === '/e2e/ping')).toHaveLength(0); // ...but without a local song there is nothing to check yet
});
