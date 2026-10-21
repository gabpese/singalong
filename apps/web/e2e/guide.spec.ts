// The original voice (the guide to sing along): the control on the phone and the TV playing the original voice along with the instrumental.
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { addToQueue, ANA, BIA, createRoom, roomState, SONGS, type TestRoom, type TestSong } from './helpers.ts';

const slider = (page: Page) => page.getByRole('slider', { name: 'Volume da voz original, como guia para cantar' });
const itemOf = async (request: APIRequestContext, room: TestRoom, song: TestSong) => (await roomState(request, room.code)).queue.find((i) => i.video_id === song.id);
const setGuide = (request: APIRequestContext, room: TestRoom, itemId: number, level: number, client = ANA) =>
  request.patch(`/api/rooms/${room.code}/queue/${itemId}`, { headers: { 'x-client-id': client }, data: { guide: level } });
const engine = (page: Page) => page.evaluate(() => ({
  level: window.tv.engine.guideLevel,
  has: window.tv.engine.hasGuide,
  playing: window.tv.engine.guidePlaying,
  drift: Math.abs(window.tv.engine.guideTime - window.tv.engine.currentTime),
}));

test.describe('the phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the bar shows only on songs that have the original voice, for whoever chose them', async ({ page, request }) => {
    const room = await createRoom(request);
    await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' }); // has the voice
    await addToQueue(request, room.code, SONGS.charlie, { name: 'Ana' }); // does not
    await page.addInitScript((id) => localStorage.setItem('clientId', id), ANA);
    await page.goto(room.guestUrl);
    await expect(page.locator('.now').getByRole('slider', { name: 'Volume da voz original, como guia para cantar' })).toBeVisible();
    await expect(page.locator('.queue-item', { hasText: 'Rolling in the Deep' }).getByRole('slider', { name: 'Volume da voz original, como guia para cantar' })).toHaveCount(0);
  });

  test('dragging the bar sends the level to the Room without touching the backing vocals', async ({ page, request }) => {
    const room = await createRoom(request);
    const id = await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' });
    await page.addInitScript((c) => localStorage.setItem('clientId', c), ANA);
    await page.goto(room.guestUrl);
    await expect(slider(page)).toHaveValue('0'); // the default: off
    await slider(page).fill('45');
    await expect.poll(async () => (await itemOf(request, room, SONGS.alpha))?.guide).toBe(45);
    expect((await itemOf(request, room, SONGS.alpha))?.backing).toBe(0);
    await setGuide(request, room, id, 80);
    await expect(slider(page)).toHaveValue('80');
  });

  test('whoever did not choose the song only sees the value', async ({ page, request }) => {
    const room = await createRoom(request);
    const id = await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' });
    await setGuide(request, room, id, 60);
    await page.addInitScript((c) => localStorage.setItem('clientId', c), BIA);
    await page.goto(room.guestUrl);
    await expect(page.getByText('Voz original (guia) 60%')).toBeVisible();
    await expect(slider(page)).toHaveCount(0);
  });
});

test.describe('the TV', () => {
  const play = async (page: Page, request: APIRequestContext, level: number) => {
    const room = await createRoom(request);
    const id = await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' });
    if (level) await setGuide(request, room, id, level);
    await page.goto(room.tvUrl);
    await expect.poll(() => page.evaluate(() => window.tv.engine.playing && window.tv.engine.currentTime > 0.3)).toBe(true);
    return { room, id };
  };

  test('with the level at 0 the original voice does not play (nor is it downloaded)', async ({ page, request }) => {
    await play(page, request, 0);
    expect(await engine(page)).toMatchObject({ level: 0, has: true, playing: false });
  });

  test("with the level above 0 the original voice plays along, at the instrumental's point", async ({ page, request }) => {
    await play(page, request, 55);
    await expect.poll(async () => (await engine(page)).playing).toBe(true);
    const state = await engine(page);
    expect(state.level).toBe(55);
    expect(state.drift).toBeLessThan(0.3);
  });

  test('changing the level mid-song turns the original voice on and off, and it lives alongside the backing vocals', async ({ page, request }) => {
    const { room, id } = await play(page, request, 0);
    await setGuide(request, room, id, 70);
    await expect.poll(async () => (await engine(page)).playing).toBe(true);
    await request.patch(`/api/rooms/${room.code}/queue/${id}`, { headers: { 'x-client-id': ANA }, data: { backing: 50 } });
    await expect.poll(() => page.evaluate(() => window.tv.engine.backingPlaying)).toBe(true);
    expect((await engine(page)).playing).toBe(true);
    await setGuide(request, room, id, 0);
    await expect.poll(async () => (await engine(page)).playing).toBe(false);
    expect(await page.evaluate(() => window.tv.engine.backingPlaying)).toBe(true); // the backing goes on
  });

  test('a song without the original voice: nothing to play even with a level set', async ({ page, request }) => {
    const room = await createRoom(request);
    const id = await addToQueue(request, room.code, SONGS.charlie, { name: 'Ana' });
    await setGuide(request, room, id, 90);
    await page.goto(room.tvUrl);
    await expect.poll(() => page.evaluate(() => window.tv.engine.playing && window.tv.engine.currentTime > 0.3)).toBe(true);
    expect(await engine(page)).toMatchObject({ has: false, playing: false });
  });
});
