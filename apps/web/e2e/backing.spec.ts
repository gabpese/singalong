// The backing vocals' level: the control on the phone (of whoever chose the song) and the TV playing the backing with the instrumental.
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { addToQueue, ANA, BIA, createRoom, roomState, SONGS, type TestRoom, type TestSong } from './helpers.ts';

const slider = (page: Page) => page.getByRole('slider', { name: 'Nível das vozes de apoio' });
const itemOf = async (request: APIRequestContext, room: TestRoom, song: TestSong) => (await roomState(request, room.code)).queue.find((i) => i.video_id === song.id);
const setBacking = (request: APIRequestContext, room: TestRoom, itemId: number, level: number, client = ANA) =>
  request.patch(`/api/rooms/${room.code}/queue/${itemId}`, { headers: { 'x-client-id': client }, data: { backing: level } });
const engine = (page: Page) => page.evaluate(() => ({
  level: window.tv.engine.backingLevel,
  has: window.tv.engine.hasBacking,
  playing: window.tv.engine.backingPlaying,
  drift: Math.abs(window.tv.engine.backingTime - window.tv.engine.currentTime),
  main: window.tv.engine.currentTime,
}));

test.describe('the phone', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the bar shows only on songs that have backing vocals, for whoever chose them', async ({ page, request }) => {
    const room = await createRoom(request);
    await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' }); // has backing
    await addToQueue(request, room.code, SONGS.charlie, { name: 'Ana' }); // does not
    await page.addInitScript((id) => localStorage.setItem('clientId', id), ANA);
    await page.goto(room.guestUrl);
    await expect(page.locator('.now').getByRole('slider', { name: 'Nível das vozes de apoio' })).toBeVisible();
    await expect(page.locator('.queue-item', { hasText: 'Rolling in the Deep' }).getByRole('slider', { name: 'Nível das vozes de apoio' })).toHaveCount(0);
  });

  test("dragging the bar sends the song's level to the Room", async ({ page, request }) => {
    const room = await createRoom(request);
    const id = await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' });
    await page.addInitScript((c) => localStorage.setItem('clientId', c), ANA);
    await page.goto(room.guestUrl);
    await expect(slider(page)).toHaveValue('0'); // the default: off
    await slider(page).fill('40');
    await expect(page.locator('.now .backing-row', { has: slider(page) }).locator('.backing-value')).toHaveText('40%');
    await expect.poll(async () => (await itemOf(request, room, SONGS.alpha))?.backing).toBe(40);
    expect(id).toBeTruthy();
    // the bar follows what the Room says (a change from elsewhere)
    await setBacking(request, room, id, 75);
    await expect(slider(page)).toHaveValue('75');
  });

  test('whoever did not choose the song only sees the value, without being able to change it', async ({ page, request }) => {
    const room = await createRoom(request);
    const id = await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' });
    await setBacking(request, room, id, 60);
    await page.addInitScript((c) => localStorage.setItem('clientId', c), BIA); // another person
    await page.goto(room.guestUrl);
    await expect(page.getByText('Vozes de apoio 60%')).toBeVisible();
    await expect(slider(page)).toHaveCount(0);
  });

  test("the Host changes any song's level, in the Queue too", async ({ page, request }) => {
    const room = await createRoom(request);
    await addToQueue(request, room.code, SONGS.charlie, { name: 'Ana' });
    await addToQueue(request, room.code, SONGS.bravo, { client: BIA, name: 'Bia' }); // Bia's, in the Queue
    await page.goto(room.hostUrl);
    const row = page.locator('.queue-item', { hasText: 'Unethical' });
    await row.getByRole('slider', { name: 'Nível das vozes de apoio' }).fill('25');
    await expect.poll(async () => (await itemOf(request, room, SONGS.bravo))?.backing).toBe(25);
  });
});

test.describe('the TV', () => {
  const play = async (page: Page, request: APIRequestContext, level: number) => {
    const room = await createRoom(request);
    const id = await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' });
    if (level) await setBacking(request, room, id, level);
    await page.goto(room.tvUrl);
    await expect.poll(() => page.evaluate(() => window.tv.engine.playing && window.tv.engine.currentTime > 0.3)).toBe(true);
    return { room, id };
  };

  test('with the level at 0 the backing vocals do not play (nor are they downloaded)', async ({ page, request }) => {
    await play(page, request, 0);
    const state = await engine(page);
    expect(state).toMatchObject({ level: 0, has: true, playing: false });
  });

  test("with the level above 0 the backing plays along, at the instrumental's point", async ({ page, request }) => {
    await play(page, request, 60);
    await expect.poll(async () => (await engine(page)).playing).toBe(true);
    const state = await engine(page);
    expect(state.level).toBe(60);
    expect(state.drift).toBeLessThan(0.3);
  });

  test('changing the level mid-song turns the backing on and off, already at the right point', async ({ page, request }) => {
    const { room, id } = await play(page, request, 0);
    await setBacking(request, room, id, 80);
    await expect.poll(async () => (await engine(page)).playing).toBe(true);
    await expect.poll(async () => (await engine(page)).drift).toBeLessThan(0.3);
    await setBacking(request, room, id, 0);
    await expect.poll(async () => (await engine(page)).playing).toBe(false);
    await setBacking(request, room, id, 30);
    await expect.poll(async () => (await engine(page)).playing).toBe(true);
    await expect.poll(async () => (await engine(page)).drift).toBeLessThan(0.3);
  });

  test('pausing, resuming and jumping the position carry the backing along', async ({ page, request }) => {
    const { room } = await play(page, request, 70);
    await expect.poll(async () => (await engine(page)).playing).toBe(true);
    const host = { 'x-client-id': ANA, 'x-host-token': room.host };
    await request.post(`/api/rooms/${room.code}/player/pause`, { headers: host });
    await expect.poll(async () => (await engine(page)).playing).toBe(false);
    await request.post(`/api/rooms/${room.code}/player/resume`, { headers: host });
    await expect.poll(async () => (await engine(page)).playing).toBe(true);
    await request.post(`/api/rooms/${room.code}/player/seek`, { headers: host, data: { to: 20 } });
    await expect.poll(async () => (await engine(page)).main).toBeGreaterThan(19.5);
    await expect.poll(async () => (await engine(page)).drift).toBeLessThan(0.3);
  });

  test('a song without backing vocals: nothing to play even with a level set', async ({ page, request }) => {
    const room = await createRoom(request);
    const id = await addToQueue(request, room.code, SONGS.charlie, { name: 'Ana' });
    await setBacking(request, room, id, 90);
    await page.goto(room.tvUrl);
    await expect.poll(() => page.evaluate(() => window.tv.engine.playing && window.tv.engine.currentTime > 0.3)).toBe(true);
    expect(await engine(page)).toMatchObject({ has: false, playing: false });
  });

  test("moving to the next song stops the previous one's backing", async ({ page, request }) => {
    const { room } = await play(page, request, 70);
    await addToQueue(request, room.code, SONGS.charlie, { client: BIA, name: 'Bia' }); // no backing
    await expect.poll(async () => (await engine(page)).playing).toBe(true);
    await request.post(`/api/rooms/${room.code}/player/skip`, { headers: { 'x-client-id': ANA, 'x-host-token': room.host } });
    await expect(page.locator('.singer.is-now')).toContainText('Rolling in the Deep');
    await expect.poll(async () => (await engine(page)).playing).toBe(false);
  });
});

// --- the SOUND, not only the state: it measures what leaves through the audio's destination (the backing track is a 440 Hz tone; the instrumental, 220 Hz) ---
test.describe('the output sound', () => {
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
      const proto = AudioNode.prototype as unknown as { connect: (this: AudioNode, dest: AudioNode | AudioParam, ...rest: number[]) => unknown };
      const connect = proto.connect;
      proto.connect = function (dest, ...rest) {
        if (dest instanceof AudioDestinationNode) {
          window.__analyser ??= Object.assign(dest.context.createAnalyser(), { fftSize: 2048 });
          connect.call(this, window.__analyser); // listens in parallel, without changing the sound's path
        }
        return connect.call(this, dest, ...rest);
      };
      window.__rms = () => {
        const analyser = window.__analyser;
        if (!analyser) return 0;
        const buffer = new Float32Array(analyser.fftSize);
        let sum = 0;
        let count = 0;
        for (let i = 0; i < 12; i++) {
          analyser.getFloatTimeDomainData(buffer);
          for (const v of buffer) { sum += v * v; count++; }
        }
        return Math.sqrt(sum / count);
      };
    });
  });

  const loudness = async (page: Page) => {
    await page.waitForTimeout(1500); // the graph settles after the level change
    const samples: number[] = [];
    for (let i = 0; i < 8; i++) {
      samples.push(await page.evaluate(() => window.__rms()));
      await page.waitForTimeout(120);
    }
    return Math.sqrt(samples.reduce((sum, v) => sum + v * v, 0) / samples.length);
  };

  test('the backing really adds to the sound: 0% = only the instrumental, 100% = both (+3 dB), 50% in between', async ({ page, request }) => {
    const room = await createRoom(request);
    const id = await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' });
    await page.goto(room.tvUrl);
    await expect.poll(() => page.evaluate(() => window.tv.engine.playing && window.tv.engine.currentTime > 0.5)).toBe(true);

    const off = await loudness(page);
    expect(off).toBeGreaterThan(0.05); // the instrumental is sounding
    await setBacking(request, room, id, 100);
    await expect.poll(async () => (await engine(page)).playing).toBe(true);
    const full = await loudness(page);
    await setBacking(request, room, id, 50);
    const half = await loudness(page);
    await setBacking(request, room, id, 0);
    const offAgain = await loudness(page);

    // two tones of the same strength add up in power: 100% = the square root of 2 times the volume (+3 dB); 50% = the square root of 1.25
    expect(full / off).toBeGreaterThan(1.3);
    expect(full / off).toBeLessThan(1.55);
    expect(half / off).toBeGreaterThan(1.05);
    expect(half / off).toBeLessThan(1.2);
    expect(offAgain / off).toBeGreaterThan(0.9);
    expect(offAgain / off).toBeLessThan(1.1);
  });

  test('the backing sounds also when the level is already on as the song loads', async ({ page, request }) => {
    const room = await createRoom(request);
    const id = await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' });
    await setBacking(request, room, id, 100); // before the TV opens
    await page.goto(room.tvUrl);
    await expect.poll(async () => (await engine(page)).playing).toBe(true);
    const withBacking = await loudness(page);
    await setBacking(request, room, id, 0);
    const without = await loudness(page);
    expect(withBacking / without).toBeGreaterThan(1.3);
  });
});
