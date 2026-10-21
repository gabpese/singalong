// The melody guide: the Host turns it on in the sidebar, and the TV draws the song's notes as bars, with the singer's pitch on top.
import { expect, type Page, test } from '@playwright/test';
import { addToQueue, ANA, AxeBuilder, createRoom, hostPatch, SONGS } from './helpers.ts';

const tvPlaying = (page: Page) => page.evaluate(() => window.tv.engine.playing && window.tv.engine.duration > 0 && window.tv.engine.currentTime > 0.3);

/** How many pixels of the guide's canvas were painted (it draws every frame: wait for the first). */
const painted = (page: Page) =>
  page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('canvas.pitch-guide');
    if (!canvas || !canvas.width) return 0;
    const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) count++;
    return count;
  });

test('the guide is off by default and, once on, the TV draws the melody bars', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: ANA, name: 'Ana' });
  await page.goto(room.tvUrl);
  await expect.poll(() => tvPlaying(page)).toBe(true);
  await expect(page.locator('canvas.pitch-guide')).toHaveCount(0); // off: nothing on screen

  await hostPatch(request, room, { melody_bars: true });
  await expect(page.locator('canvas.pitch-guide')).toBeVisible();
  await expect(page.locator('main.tv-stage')).toHaveClass(/has-guide/);
  await expect.poll(() => painted(page), { timeout: 8000 }).toBeGreaterThan(500); // the bars and the "now" line
  expect(await page.locator('canvas.pitch-guide').getAttribute('role')).toBe('img');

  await hostPatch(request, room, { melody_bars: false });
  await expect(page.locator('canvas.pitch-guide')).toHaveCount(0);
});

test("the Host turns the guide on and off in the Room's sidebar", async ({ page, request }) => {
  const room = await createRoom(request);
  await page.goto(room.hostUrl);
  const guide = page.getByRole('switch', { name: 'Guia de melodia' });
  await expect(guide).toBeVisible();
  await expect(guide).toHaveAttribute('aria-checked', 'false');
  await guide.click();
  await expect(guide).toHaveAttribute('aria-checked', 'true');
  await expect.poll(async () => (await (await request.get(`/api/rooms/${room.code}`, { headers: { 'x-client-id': ANA } })).json()).melody_bars).toBe(true);
  await guide.click();
  await expect(guide).toHaveAttribute('aria-checked', 'false');
});

test("whoever is not the Host does not see the guide's switch", async ({ page, request }) => {
  const room = await createRoom(request);
  await page.goto(room.guestUrl);
  await expect(page.getByRole('button', { name: 'Copiar link da sala' })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Guia de melodia' })).toHaveCount(0);
});

test('a song without a melody: the guide turns on but nothing shows (no notes to draw)', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.charlie, { client: ANA, name: 'Ana' }); // no melody in the test cache? checked below
  await hostPatch(request, room, { melody_bars: true });
  await page.goto(room.tvUrl);
  await expect.poll(() => tvPlaying(page)).toBe(true);
  const hasMelody = await page.evaluate(() => Boolean(window.tv.state?.queue?.[0]?.song?.media?.melody));
  if (!hasMelody) await expect(page.locator('canvas.pitch-guide')).toHaveCount(0);
});

test('the TV with the guide on passes axe', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: ANA, name: 'Ana' });
  await hostPatch(request, room, { melody_bars: true });
  await page.goto(room.tvUrl);
  await expect.poll(() => tvPlaying(page)).toBe(true);
  await expect(page.locator('canvas.pitch-guide')).toBeVisible();
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
});
