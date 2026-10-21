// The TV's layout (first adjusted in 1.2.1): the lyrics lines never overlap, the line already sung fades, the score sits on the
// right (outside the melody guide), the Room's sidebar sits below the top bar, and the voice's volume shows only when looked for.
import { expect, type Locator, type Page, test } from '@playwright/test';
import { addToQueue, ANA, BIA, createRoom, hostPatch, SONGS } from './helpers.ts';

type Box = { x: number; y: number; w: number; h: number; right: number; bottom: number };

const tvPlaying = (page: Page) => page.evaluate(() => window.tv.engine.playing && window.tv.engine.duration > 0 && window.tv.engine.currentTime > 1.2);
const box = (locator: Locator): Promise<Box> => locator.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; });
const overlap = (a: Box, b: Box) => a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom;

test('the lyrics fit the card: no line goes over another, even with a big font and a small screen', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: ANA, name: 'Ana' });
  await page.addInitScript(() => localStorage.setItem('lyricsScale', '1.8'));
  await page.setViewportSize({ width: 560, height: 380 });
  await page.goto(room.tvUrl);
  await expect.poll(() => tvPlaying(page)).toBe(true);
  await expect(page.locator('.line.current')).toContainText('Segunda linha cantada agora');
  await page.waitForTimeout(400);
  const lines = await Promise.all(['.line.current', '.line.next', '.line.next2'].map((selector) => box(page.locator(selector))));
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) if (lines[i].h > 0 && lines[j].h > 0) expect(overlap(lines[i], lines[j]), `lines ${i} and ${j} overlap`).toBe(false);
  expect(await page.locator('.lyrics').evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true); // it all fits the card
});

test('the lyrics already sung fade (low opacity) and the coming ones are a subtle white', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: ANA, name: 'Ana' });
  await page.goto(room.tvUrl);
  await expect.poll(() => tvPlaying(page)).toBe(true);
  await expect(page.locator('.line.current')).toContainText('Segunda linha cantada agora');
  const opacity = (selector: string) => page.locator(selector).evaluate((el) => Number(getComputedStyle(el).opacity));
  expect(await opacity('.line.prev')).toBeLessThan(0.5); // the line that went by loses its strength
  expect(await opacity('.line.next')).toBe(1); // the coming one keeps its opacity: its color is a translucent white
  const color = await page.locator('.line.next').evaluate((el) => getComputedStyle(el).color);
  expect(color).toMatch(/^rgba\(255, 255, 255, 0\.\d+\)$/);
});

test('the score sits at the far right and does not cover the melody guide', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: ANA, name: 'Ana' });
  await hostPatch(request, room, { scoring: true, melody_bars: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(room.tvUrl);
  await expect.poll(() => tvPlaying(page)).toBe(true);
  await expect(page.locator('canvas.pitch-guide')).toBeVisible();
  const hud = await box(page.locator('.score-hud'));
  const guide = await box(page.locator('canvas.pitch-guide'));
  expect(hud.right).toBeGreaterThan(1280 - 48); // against the right edge
  expect(overlap(hud, guide)).toBe(false); // the guide ends before the card
  expect(guide.w).toBeGreaterThan(700); // and stays wide
});

test("without the melody guide the score's card sits on the right too", async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: ANA, name: 'Ana' });
  await hostPatch(request, room, { scoring: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(room.tvUrl);
  await expect(page.locator('.score-hud')).toBeVisible();
  expect((await box(page.locator('.score-hud'))).right).toBeGreaterThan(1280 - 48);
});

test.describe('the Room on a computer', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test('the language picker does not stretch the top bar, and the sidebar sits below it', async ({ page, request }) => {
    const room = await createRoom(request);
    await page.goto(room.hostUrl);
    const header = await box(page.locator('header.topbar'));
    const select = await box(page.locator('header.topbar .language-switch'));
    const rail = await box(page.locator('aside.room-rail'));
    expect(select.w).toBeLessThan(260); // it used to take the whole top bar
    expect(header.h).toBeLessThan(110);
    expect(rail.y).toBeGreaterThanOrEqual(header.bottom - 1); // the sidebar is not behind the top bar
  });

  test("the voice's volume next to its switch shows only with the mouse over it (and does not stay open after the click)", async ({ page, request }) => {
    const room = await createRoom(request);
    await hostPatch(request, room, { voice: true });
    await page.goto(room.hostUrl);
    const popup = page.locator('.rail-pop');
    const voiceSwitch = page.getByRole('switch', { name: /Voz do microfone/ });
    await expect(voiceSwitch).toBeVisible();
    await page.mouse.move(700, 500);
    await expect(popup).toHaveCSS('opacity', '0');
    await voiceSwitch.hover();
    await expect(popup).toHaveCSS('opacity', '1');
    const pop = await box(popup);
    const sw = await box(voiceSwitch);
    expect(Math.abs((pop.y + pop.h / 2) - (sw.y + sw.h / 2))).toBeLessThan(8); // centered on the switch
    await page.mouse.move(900, 600);
    await expect(popup).toHaveCSS('opacity', '0');
  });
});

// the owner's app window is much smaller than a TV: nothing may sit on top of anything
for (const size of [{ width: 1100, height: 740 }, { width: 1100, height: 800 }, { width: 1280, height: 720 }, { width: 1366, height: 768 }, { width: 1920, height: 1080 }, { width: 1000, height: 600 }, { width: 960, height: 560 }]) {
  test(`with the guide and the score on, no card overlaps another (${size.width}x${size.height})`, async ({ page, request }) => {
    const room = await createRoom(request);
    // a full Queue: the song playing plus seven waiting (the right column at its tallest)
    const songs = [SONGS.alpha, SONGS.bravo, SONGS.charlie, SONGS.delta];
    for (let i = 0; i < 8; i++) await addToQueue(request, room.code, songs[i % 4], { client: i % 2 ? ANA : BIA, name: i % 2 ? 'Ana' : 'Bia' });
    await hostPatch(request, room, { scoring: true, melody_bars: true });
    await page.setViewportSize(size);
    await page.goto(room.tvUrl);
    await expect.poll(() => tvPlaying(page)).toBe(true);
    await expect(page.locator('canvas.pitch-guide')).toBeVisible();
    await expect(page.locator('.score-hud')).toBeVisible();
    await page.waitForTimeout(300);
    const cards = {
      lyrics: await box(page.locator('.lyrics')),
      queue: await box(page.locator('.tv-queue')),
      qr: await box(page.locator('.tv-join')),
      singer: await box(page.locator('.singer.is-now')),
      guide: await box(page.locator('canvas.pitch-guide')),
      hud: await box(page.locator('.score-hud')),
      progress: await box(page.locator('.tv-progress')),
    };
    const names = Object.keys(cards) as (keyof typeof cards)[];
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) expect(overlap(cards[names[i]], cards[names[j]]), `${names[i]} over ${names[j]}`).toBe(false);
    }
    expect(cards.hud.right).toBeGreaterThan(size.width - 48); // still against the right edge
    expect(cards.hud.bottom).toBeLessThanOrEqual(size.height); // and fits the screen
    expect(cards.qr.bottom).toBeLessThanOrEqual(size.height); // the QR code fits the screen too
    expect(cards.qr.bottom).toBeLessThanOrEqual(cards.lyrics.y + 1); // the QR code sits at the top, beside who is singing, not over the lyrics
    expect(cards.qr.right).toBeLessThanOrEqual(cards.singer.x + 1); // to the left of "Cantando agora"
    expect(cards.queue.x).toBeGreaterThanOrEqual(cards.lyrics.right); // the Queue has the column beside the lyrics to itself
    expect(cards.queue.y).toBeLessThanOrEqual(cards.lyrics.y + 40);
    expect(cards.queue.bottom).toBeLessThanOrEqual(cards.hud.y + 1); // and ends before the bottom strip
  });
}
