// Accessibility: axe-core checks the contrast, the controls' names, the roles and the labels on every screen.
import { expect, type Page, test } from '@playwright/test';
import { addToQueue, ANA, AxeBuilder, BIA, createRoom, SONGS } from './helpers.ts';

test.use({ viewport: { width: 390, height: 844 } });

const tvPlaying = (page: Page) => page.evaluate(() => window.tv.engine.playing && window.tv.engine.duration > 0 && window.tv.engine.currentTime > 0);

async function violations(page: Page) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return result.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
}

test('the landing page', async ({ page }) => {
  await page.goto('/');
  expect(await violations(page)).toEqual([]);
});

test('the Room: the tabs, the Queue and adding a song', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: BIA, name: 'Bia' });
  await addToQueue(request, room.code, SONGS.bravo, { client: ANA, name: 'Ana' });
  await page.goto(room.hostUrl);
  await expect(page.locator('.queue-item').first()).toBeVisible();
  expect(await violations(page)).toEqual([]);
  await page.getByRole('button', { name: /Adicionar/ }).last().click();
  expect(await violations(page)).toEqual([]);
  await page.getByRole('button', { name: /Jukebox/ }).click();
  expect(await violations(page)).toEqual([]);
});

test("the Room's TV tab", async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: BIA, name: 'Bia' });
  await page.goto(`${room.guestUrl}&view=tv`);
  await expect(page.locator('.tv-viewer')).toBeVisible();
  expect(await violations(page)).toEqual([]);
});

test('the TV playing', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: BIA, name: 'Bia' });
  await addToQueue(request, room.code, SONGS.bravo, { client: ANA, name: 'Ana' });
  await page.goto(room.tvUrl);
  await expect.poll(() => tvPlaying(page)).toBe(true);
  expect(await violations(page)).toEqual([]);
});

test("the dialogs: the name on arrival and the speakers' voice notice", async ({ browser, request }) => {
  const room = await createRoom(request);
  const fresh = await browser.newContext({ viewport: { width: 390, height: 844 }, storageState: { cookies: [], origins: [] } });
  const guest = await fresh.newPage();
  await guest.goto(room.guestUrl);
  await expect(guest.getByRole('dialog')).toBeVisible();
  expect(await violations(guest)).toEqual([]);
  await fresh.close();

  const host = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await host.newPage();
  await page.goto(room.hostUrl);
  await page.getByRole('switch', { name: /Voz do microfone/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await violations(page)).toEqual([]);
  await host.close();
});

test('the lyrics size: A+ enlarges it, the choice is kept, and the "skip to content" link exists', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: BIA, name: 'Bia' });
  await page.goto(`${room.guestUrl}&view=tv`);
  const scale = () => page.evaluate(() => document.documentElement.style.getPropertyValue('--lyrics-scale'));
  expect(await scale()).toBe('1');
  await page.getByRole('button', { name: 'Aumentar a letra' }).click();
  expect(await scale()).toBe('1.25');
  await page.reload();
  expect(await scale()).toBe('1.25'); // kept in this browser
  await page.getByRole('button', { name: 'Diminuir a letra' }).click();
  expect(await scale()).toBe('1');
  await page.reload(); // the focus goes back to the page's start
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Ir para o conteúdo' })).toBeFocused();
});

test("a screen reader's notice announces who is singing", async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: BIA, name: 'Bia' });
  await page.goto(room.guestUrl);
  await expect(page.locator('p.sr-only[role="status"]')).toContainText('Agora na TV: Bia, Wicked Game');
});

test("the sound delay's dialog", async ({ page, request }) => {
  const room = await createRoom(request);
  await page.goto(room.tvUrl);
  await page.keyboard.press('l');
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await violations(page)).toEqual([]);
});

test("the microphones' dialog", async ({ page, request }) => {
  const room = await createRoom(request);
  await page.goto(room.tvUrl);
  await page.keyboard.press('m');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('checkbox').first()).toBeVisible();
  expect(await violations(page)).toEqual([]);
});

test("the Room with the backing vocals' and the original voice's bars", async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: ANA, name: 'Ana' });
  await page.addInitScript((id) => localStorage.setItem('clientId', id), ANA);
  await page.goto(room.guestUrl);
  await expect(page.getByRole('slider', { name: /guia para cantar/ })).toBeVisible();
  expect(await violations(page)).toEqual([]);
});

test("the landing page on a computer, with the app's block", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0 Safari/537.36' });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Baixar o app' })).toBeVisible();
  expect(await violations(page)).toEqual([]);
  await context.close();
});

test('the Room with the reaction buttons', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: BIA, name: 'Bia' });
  await page.goto(room.guestUrl);
  await expect(page.getByRole('group', { name: 'Reações' })).toBeVisible();
  expect(await violations(page)).toEqual([]);
});

test("the landing page on a Mac, with the Apple Silicon button and the Intel tip open", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15' });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Baixar para macOS (Apple Silicon)' })).toBeVisible();
  expect(await violations(page)).toEqual([]);
  await page.getByRole('button', { name: 'Sobre o Mac Intel' }).click(); // the open tip passes axe too (contrast, name, description)
  await expect(page.getByRole('tooltip')).toBeVisible();
  expect(await violations(page)).toEqual([]);
  await context.close();
});
