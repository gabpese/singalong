// The Stage: when a singer's song comes up, their phone goes from the Room to the Stage (the lyrics at the TV's pace) and back when it ends.
import { type APIRequestContext, type Browser, expect, type Page, test } from '@playwright/test';
import { addToQueue, ANA, BIA, createRoom, publishLocalSong, SONGS, startAgentSession, type TestRoom } from './helpers.ts';

test.use({ viewport: { width: 390, height: 844 } });

const MEDIA_BASE = 'http://127.0.0.1:3101/e2e';
const LOCAL = { id: 'localStage1', title: 'Tempo Perdido', artist: 'Legião Urbana' };

/** A person on a phone: their browser has its own client_id (it is how the Room knows whose song it is). */
async function phone(browser: Browser, client: string) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript((id) => localStorage.setItem('clientId', id), client);
  return { context, page: await context.newPage() };
}

const tvPlaying = (page: Page) => page.evaluate(() => window.tv.engine.playing && window.tv.engine.duration > 0 && window.tv.engine.currentTime > 0);
const hostPost = (request: APIRequestContext, room: TestRoom, path: string) => request.post(`/api/rooms/${room.code}${path}`, { headers: { 'x-client-id': ANA, 'x-host-token': room.host } });

test("when their song comes up the singer goes to the Stage, sees the lyrics at the TV's pace and returns to the Room when it ends", async ({ browser, page: tv, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: ANA, name: 'Ana' });
  await tv.goto(room.tvUrl);
  await expect.poll(() => tvPlaying(tv)).toBe(true);

  const ana = await phone(browser, ANA);
  await ana.page.goto(room.guestUrl);
  await expect(ana.page).toHaveURL(new RegExp(`/stage\\.html\\?room=${room.code}`)); // redirected from the Room to the Stage
  await expect(ana.page.getByRole('heading', { name: 'Wicked Game' })).toBeVisible();
  await expect(ana.page.locator('.stage-where')).toContainText(`Sala ${room.code}`);
  await expect(ana.page.locator('.stage-artist')).toContainText('Ana');
  await expect(ana.page.locator('.line.current')).toContainText('Primeira linha da letra'); // the lyrics move with the TV's song
  await expect(ana.page.locator('.line.next')).toContainText('Segunda linha cantada agora');
  await expect.poll(() => ana.page.locator('.line.current .w').evaluateAll((els) => els.filter((e) => parseFloat((e as HTMLElement).style.getPropertyValue('--p')) > 0).length)).toBeGreaterThan(0);

  // the Host skips: the Stage shows the end and sends Ana back to the Room
  await hostPost(request, room, '/player/skip');
  await expect(ana.page.getByText('Acabou!')).toBeVisible();
  await expect(ana.page).toHaveURL(new RegExp(`/room\\.html\\?room=${room.code}`), { timeout: 10_000 });
  await ana.context.close();
});

test("whoever is not the current singer stays in the Room, and without a TV connected nobody is taken to the Stage", async ({ browser, page: tv, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: ANA, name: 'Ana' });

  const ana = await phone(browser, ANA);
  await ana.page.goto(room.guestUrl);
  await expect(ana.page.getByText('Wicked Game').first()).toBeVisible();
  await ana.page.waitForTimeout(800);
  expect(ana.page.url()).toContain('/room.html'); // the TV is not connected yet: no Stage

  await tv.goto(room.tvUrl);
  await expect.poll(() => tvPlaying(tv)).toBe(true);
  await expect(ana.page).toHaveURL(/\/stage\.html/); // with the TV playing, Ana goes to the Stage

  const bia = await phone(browser, BIA);
  await bia.page.goto(room.guestUrl);
  await expect(bia.page.getByText('Wicked Game').first()).toBeVisible();
  await bia.page.waitForTimeout(800);
  expect(bia.page.url()).toContain('/room.html'); // Bia does not sing now: she stays in the Room
  await ana.context.close();
  await bia.context.close();
});

test('"Voltar à sala" leaves the Stage, and the Room does not take the singer back during this song', async ({ browser, page: tv, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: ANA, name: 'Ana' });
  await addToQueue(request, room.code, SONGS.bravo, { client: ANA, name: 'Ana' });
  await tv.goto(room.tvUrl);
  await expect.poll(() => tvPlaying(tv)).toBe(true);

  const ana = await phone(browser, ANA);
  await ana.page.goto(room.guestUrl);
  await expect(ana.page).toHaveURL(/\/stage\.html/);
  await ana.page.getByRole('button', { name: 'Voltar à sala' }).click();
  await expect(ana.page).toHaveURL(/\/room\.html/);
  await ana.page.waitForTimeout(1200);
  expect(ana.page.url()).toContain('/room.html'); // it does not go back to the Stage while the same song plays

  await hostPost(request, room, '/player/skip'); // the next song is Ana's too: then she is taken to the Stage
  await expect(ana.page).toHaveURL(/\/stage\.html/, { timeout: 10_000 });
  await expect(ana.page.getByRole('heading', { name: 'Unethical' })).toBeVisible();
  await ana.context.close();
});

test("whoever opens the Stage when it is not their turn goes straight back to the Room", async ({ browser, request }) => {
  const room = await createRoom(request);
  const bia = await phone(browser, BIA);
  await bia.page.goto(`/stage.html?room=${room.code}`);
  await expect(bia.page).toHaveURL(/\/room\.html/);
  await bia.context.close();
});

test("with the song on the owner's computer, the lyrics reach the Stage relayed by the TV", async ({ browser, page: tv, request }) => {
  await request.post('/__test/seed-song', { data: LOCAL });
  const { headers, room, tvUrl, guestUrl } = await startAgentSession(request, 'Dona Flor', MEDIA_BASE);
  await publishLocalSong(request, headers, LOCAL);
  const added = await request.post(`/api/rooms/${room.code}/queue`, { headers: { 'x-client-id': ANA }, data: { video_id: LOCAL.id, name: 'Ana' } });
  expect(added.status(), await added.text()).toBe(201);
  await tv.goto(tvUrl);
  await expect.poll(() => tvPlaying(tv)).toBe(true);

  const ana = await phone(browser, ANA);
  const lyricRequests: string[] = [];
  ana.page.on('request', (req) => { if (req.url().includes('lyrics.json')) lyricRequests.push(req.url()); });
  await ana.page.goto(guestUrl);
  await expect(ana.page).toHaveURL(/\/stage\.html/);
  await expect(ana.page.locator('.line.current')).toContainText('Primeira linha da letra');
  expect(lyricRequests).toEqual([]); // the phone never reaches the local media server: the lyrics came through the TV
  await ana.context.close();
  await request.post('/__test/remove-song', { data: { id: LOCAL.id } });
});

test('a song without a Duet: the lyrics get no line owner (nor the Duet\'s colored dot)', async ({ browser, page: tv, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: ANA, name: 'Ana' });
  await tv.goto(room.tvUrl);
  await expect.poll(() => tvPlaying(tv)).toBe(true);
  await expect(tv.locator('.line.next')).toContainText('Segunda linha');
  expect(await tv.locator('.lyrics [data-part]').count()).toBe(0); // no attribute, so no dot
  const ana = await phone(browser, ANA);
  await ana.page.goto(room.guestUrl);
  await expect(ana.page.locator('.line.current')).toContainText('Primeira linha da letra');
  expect(await ana.page.locator('.stage-lyrics [data-part]').count()).toBe(0);
  await ana.context.close();
});
