// The Intermission between songs: applause for whoever just sang and the walk to the stage of whoever comes next (on the test
// server each phase lasts 3 s, and the Rooms start with the Intermission off; these tests turn it on).
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { addToQueue, ANA, AxeBuilder, BIA, createRoom, hostPatch, roomState, SONGS, type TestRoom } from './helpers.ts';

const violations = async (page: Page) =>
  (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
// the Intermission happens only with the TV connected: the tests wait for the TV to join the Room before queueing the first song
const tvConnected = (request: APIRequestContext, room: TestRoom) => expect.poll(async () => (await roomState(request, room.code)).tv_connected).toBe(true);
const playing = (page: Page) => page.evaluate(() => window.tv.engine.playing && window.tv.engine.currentTime > 0);
const finishSong = (page: Page) => page.evaluate(() => window.tv.engine.seek(window.tv.engine.duration - 0.3));

test('the TV shows the walk to the stage with the countdown (the sound waits), then plays; at the end, applause and the next one goes up', async ({ page, request }) => {
  const room = await createRoom(request);
  await hostPatch(request, room, { intermission: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(room.tvUrl);
  await tvConnected(request, room);
  await addToQueue(request, room.code, SONGS.alpha, { client: ANA, name: 'Ana' });
  await addToQueue(request, room.code, SONGS.bravo, { client: BIA, name: 'Bia' });

  const stage = page.locator('.interlude.stage-up');
  await expect(stage).toBeVisible();
  await expect(stage.getByText('Próximo no palco')).toBeVisible();
  await expect(stage.locator('.interlude-who')).toHaveText('Ana');
  await expect(stage.getByRole('timer')).toContainText('Começa em');
  await expect(stage.locator('.walker .singer-blobs .blob')).toHaveCount(1); // the singer's little creature climbs the stairs
  expect(await playing(page)).toBe(false); // the song is already chosen, but it waits for the singer to arrive
  await page.waitForTimeout(700); // the scene comes in with a 0.5 s fade: the contrast counts with all of it on screen
  expect(await violations(page)).toEqual([]);
  await expect(stage).toBeHidden({ timeout: 6000 });
  await expect.poll(() => playing(page)).toBe(true);

  await finishSong(page);
  const applause = page.locator('.interlude.applause');
  await expect(applause).toBeVisible();
  await expect(applause.getByText('Aplausos para')).toBeVisible();
  await expect(applause.locator('.interlude-who')).toContainText('Ana');
  await expect(applause.locator('.crowd .crowd-blob')).toHaveCount(14); // the audience
  await page.waitForTimeout(700); // the scene comes in with a 0.5 s fade: the contrast counts with all of it on screen
  expect(await violations(page)).toEqual([]);
  expect(await playing(page)).toBe(false);
  // after the applause, Bia goes up to the stage
  await expect(page.locator('.interlude.stage-up .interlude-who')).toHaveText('Bia', { timeout: 6000 });
});

test('the phone shows the Intermission; the Host skips it with "Começar agora", and the singer\'s Stage calls the person', async ({ browser, page, request }) => {
  const room = await createRoom(request);
  await hostPatch(request, room, { intermission: true });
  await page.goto(room.tvUrl);
  const phone = async (client: string, name: string, url: string) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.addInitScript(([c, n]) => { localStorage.setItem('clientId', c); localStorage.setItem('userName', n); }, [client, name]);
    const p = await context.newPage();
    await p.goto(url);
    return { page: p, close: () => context.close() };
  };
  const host = await phone('client-host-0001', 'Gabi', room.hostUrl);
  const ana = await phone(ANA, 'Ana', room.guestUrl);
  await tvConnected(request, room);
  await addToQueue(request, room.code, SONGS.alpha, { client: ANA, name: 'Ana' });

  // whoever sings next is taken to the Stage, and there is the call with the countdown
  await expect(ana.page).toHaveURL(/\/stage\.html/);
  await expect(ana.page.getByText('Sua vez. Suba ao palco.')).toBeVisible();
  await expect(ana.page.getByText(/A música começa em \d+ s/)).toBeVisible();

  // in the Room, the notice; the Host skips the Intermission and the song starts at once
  const banner = host.page.locator('.interlude-banner');
  await expect(banner).toContainText('Ana está subindo ao palco');
  await banner.getByRole('button', { name: 'Começar agora' }).click();
  await expect.poll(async () => (await roomState(request, room.code)).playback).toBe('playing');
  await expect(banner).toBeHidden();
  await expect(ana.page.getByText('Sua vez. Suba ao palco.')).toBeHidden();
  await host.close();
  await ana.close();
});

test("the Host turns the Intermission on and off in the sidebar; whoever is not the Host does not see the switch", async ({ browser, page, request }) => {
  const room = await createRoom(request);
  await page.goto(room.hostUrl);
  const toggle = page.getByRole('switch', { name: 'Intervalo entre músicas' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false'); // the tests' Rooms start with it off
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect.poll(async () => (await roomState(request, room.code)).intermission).toBe(true);
  const context = await browser.newContext();
  const guest = await context.newPage();
  await guest.goto(room.guestUrl);
  await expect(guest.getByRole('heading', { name: `Sala ${room.code}` })).toBeVisible();
  await expect(guest.getByRole('switch', { name: 'Intervalo entre músicas' })).toHaveCount(0);
  await context.close();
});
