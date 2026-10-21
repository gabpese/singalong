// The phones' reactions: one tap sends applause, fire... that rises on the TV, on the Room's TV tab and on the singer's Stage.
import { type Browser, expect, type Page, test } from '@playwright/test';
import { addToQueue, ANA, BIA, createRoom, SONGS } from './helpers.ts';

const tvPlaying = (page: Page) => page.evaluate(() => window.tv.engine.playing && window.tv.engine.duration > 0 && window.tv.engine.currentTime > 0);

/** A person on a phone, with their name (it is what shows next to the reaction). */
async function phone(browser: Browser, client: string, name: string) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(([id, who]) => {
    localStorage.setItem('clientId', id);
    localStorage.setItem('userName', who);
  }, [client, name]);
  return { context, page: await context.newPage() };
}

test("a tap on the phone makes the reaction rise on the TV, with the sender's name", async ({ browser, page: tv, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: ANA, name: 'Ana' });
  await tv.goto(room.tvUrl);
  await expect.poll(() => tvPlaying(tv)).toBe(true);

  const bia = await phone(browser, BIA, 'Bia');
  await bia.page.goto(room.guestUrl);
  await expect(bia.page.getByRole('group', { name: 'Reações' })).toBeVisible();
  await bia.page.getByRole('button', { name: 'Aplaudir' }).click();
  await expect(tv.locator('.reaction').first()).toContainText('👏');
  await expect(tv.locator('.reaction small').first()).toHaveText('Bia');
  expect(await tv.locator('.reaction-layer').getAttribute('aria-hidden')).toBe('true'); // decoration: the screen reader does not read it
  await bia.page.getByRole('button', { name: 'Fogo' }).click();
  await expect(tv.locator('.reaction', { hasText: '🔥' })).toHaveCount(1);
  // it goes away by itself after rising
  await expect(tv.locator('.reaction')).toHaveCount(0, { timeout: 6000 });
  await bia.context.close();
});

test('whoever taps nonstop is limited: the TV does not become a cloud of emojis', async ({ browser, page: tv, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: ANA, name: 'Ana' });
  await tv.goto(room.tvUrl);
  await expect.poll(() => tvPlaying(tv)).toBe(true);
  const bia = await phone(browser, BIA, 'Bia');
  await bia.page.goto(room.guestUrl);
  const button = bia.page.getByRole('button', { name: 'Festa' });
  const started = Date.now();
  for (let i = 0; i < 30; i++) await button.click({ delay: 0 });
  const seconds = (Date.now() - started) / 1000;
  await tv.waitForTimeout(500);
  const shown = await tv.locator('.reaction').count();
  expect(shown).toBeGreaterThan(0);
  // the server's bucket starts with 6 tokens and refills 3 per second: on a slow computer the clicks take longer and more reactions pass
  expect(shown).toBeLessThanOrEqual(Math.ceil(6 + 3 * (seconds + 0.5)) + 1);
  expect(shown).toBeLessThan(30);
  await bia.context.close();
});

test("the Room's TV tab and the singer's Stage see the reactions too", async ({ browser, page: tv, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: ANA, name: 'Ana' }); // Ana's song: she goes to the Stage
  await tv.goto(room.tvUrl);
  await expect.poll(() => tvPlaying(tv)).toBe(true);

  const ana = await phone(browser, ANA, 'Ana');
  await ana.page.goto(room.guestUrl);
  await expect(ana.page).toHaveURL(/\/stage\.html/);

  const caio = await phone(browser, 'client-caio-0001', 'Caio');
  await caio.page.goto(`${room.guestUrl}&view=tv`);
  await expect(caio.page.locator('.tv-viewer')).toBeVisible();
  const bia = await phone(browser, BIA, 'Bia');
  await bia.page.goto(room.guestUrl);
  await bia.page.getByRole('button', { name: 'Amei' }).click();

  await expect(ana.page.locator('.reaction', { hasText: '❤️' })).toHaveCount(1); // on the Stage
  await expect(caio.page.locator('.reaction', { hasText: '❤️' })).toHaveCount(1); // on the TV tab
  await expect(caio.page.getByRole('group', { name: 'Reações' })).toBeVisible(); // and one can react from there too
  for (const p of [ana, caio, bia]) await p.context.close();
});
