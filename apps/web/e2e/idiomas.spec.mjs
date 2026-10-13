// Idiomas: a interface acompanha o idioma escolhido (ou o do navegador) e lembra a escolha.
import { expect, test } from '@playwright/test';
import { addToQueue, createRoom, SONGS } from './helpers.mjs';

test('trocar o idioma na entrada traduz a página e a escolha continua na sala', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Criar uma sala' })).toBeVisible();
  await page.getByLabel('Idioma').selectOption('en');
  await expect(page.getByRole('heading', { name: 'Create a room' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha);
  await page.goto(room.guestUrl);
  await expect(page.getByRole('tab', { name: 'TV' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Queue/ })).toBeVisible();
  await page.getByLabel('Language').selectOption('es');
  await expect(page.getByRole('navigation', { name: 'Secciones' })).toBeVisible();
});

test('sem escolha salva o navegador decide: inglês no navegador em inglês', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'en-US' });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Join a room' })).toBeVisible();
  await context.close();
});
