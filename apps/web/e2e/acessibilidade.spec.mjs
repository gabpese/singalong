// Acessibilidade: o axe-core confere contraste, nomes dos controles, papéis e rótulos em cada tela.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { addToQueue, ANA, BIA, createRoom, SONGS } from './helpers.mjs';

test.use({ viewport: { width: 390, height: 844 } });

const tvPlaying = (page) => page.evaluate(() => window.tv.engine.playing && window.tv.engine.duration > 0 && window.tv.engine.currentTime > 0);

async function violations(page) {
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  return result.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
}

test('entrada', async ({ page }) => {
  await page.goto('/');
  expect(await violations(page)).toEqual([]);
});

test('sala: abas, fila e adicionar', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: BIA, name: 'Bia' });
  await addToQueue(request, room.code, SONGS.bravo, { client: ANA, name: 'Ana' });
  await page.goto(room.hostUrl);
  await expect(page.locator('.queue-item').first()).toBeVisible();
  expect(await violations(page)).toEqual([]);
  await page.getByRole('button', { name: /Adicionar/ }).last().click();
  expect(await violations(page)).toEqual([]);
  await page.getByRole('button', { name: /Músicas/ }).click();
  expect(await violations(page)).toEqual([]);
});

test('aba TV da sala', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: BIA, name: 'Bia' });
  await page.goto(`${room.guestUrl}&view=tv`);
  await expect(page.locator('.tv-viewer')).toBeVisible();
  expect(await violations(page)).toEqual([]);
});

test('TV que toca', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: BIA, name: 'Bia' });
  await addToQueue(request, room.code, SONGS.bravo, { client: ANA, name: 'Ana' });
  await page.goto(room.tvUrl);
  await expect.poll(() => tvPlaying(page)).toBe(true);
  expect(await violations(page)).toEqual([]);
});

test('diálogos: nome na chegada e aviso da voz nas caixas', async ({ browser, request }) => {
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

test('tamanho da letra: A+ aumenta, a escolha fica guardada e o link "ir para o conteúdo" existe', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: BIA, name: 'Bia' });
  await page.goto(`${room.guestUrl}&view=tv`);
  const scale = () => page.evaluate(() => document.documentElement.style.getPropertyValue('--lyrics-scale'));
  expect(await scale()).toBe('1');
  await page.getByRole('button', { name: 'Aumentar a letra' }).click();
  expect(await scale()).toBe('1.25');
  await page.reload();
  expect(await scale()).toBe('1.25'); // guardado neste navegador
  await page.getByRole('button', { name: 'Diminuir a letra' }).click();
  expect(await scale()).toBe('1');
  await page.reload(); // o foco volta ao início da página
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Ir para o conteúdo' })).toBeFocused();
});

test('um aviso para leitor de tela anuncia quem está cantando', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: BIA, name: 'Bia' });
  await page.goto(room.guestUrl);
  await expect(page.locator('p.sr-only[role="status"]')).toContainText('Agora na TV: Bia, Wicked Game');
});

test('diálogo do atraso do som', async ({ page, request }) => {
  const room = await createRoom(request);
  await page.goto(room.tvUrl);
  await page.keyboard.press('l');
  await expect(page.getByRole('dialog')).toBeVisible();
  expect(await violations(page)).toEqual([]);
});
