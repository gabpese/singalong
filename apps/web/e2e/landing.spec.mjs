import { expect, test } from '@playwright/test';
import { createRoom } from './helpers.mjs';

test.use({ viewport: { width: 390, height: 844 } });

test('a entrada tem o título, criar sala e entrar numa sala', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Singalong', level: 1 })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Criar uma sala' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Entrar numa sala' })).toBeVisible();
  await expect(page).toHaveTitle('Singalong');
});

test('criar sala abre a TV em outra aba e leva o anfitrião para a sala', async ({ page, context }) => {
  await page.goto('/');
  const popup = context.waitForEvent('page');
  await page.getByRole('button', { name: 'Criar sala e abrir a TV' }).click();
  const tv = await popup;
  await expect(page).toHaveURL(/\/room\.html\?room=[A-Z0-9]{4}$/);
  const code = new URL(page.url()).searchParams.get('room');
  expect(new URL(tv.url()).pathname).toBe('/tv.html');
  expect(new URL(tv.url()).searchParams.get('room')).toBe(code);
  // quem criou é o anfitrião: o menu mostra as opções que só ele tem
  await expect(page.getByRole('heading', { name: `Sala ${code}` })).toBeVisible();
  await page.getByLabel('Opções da sala').click();
  await expect(page.getByRole('button', { name: 'Copiar link de anfitrião' })).toBeVisible();
  await expect(page.getByLabel(/Rodízio justo/)).toBeVisible();
});

test('entrar com o código de uma sala que existe', async ({ page, request }) => {
  const { code } = await createRoom(request);
  await page.goto('/');
  await page.getByLabel('Código da sala').fill(code.toLowerCase()); // minúsculas também valem
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page).toHaveURL(`/room.html?room=${code}`);
  await expect(page.getByRole('heading', { name: `Sala ${code}` })).toBeVisible();
});

test('código que não existe mostra o erro e fica na entrada', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Código da sala').fill('ZZZZ');
  await page.getByRole('button', { name: 'Entrar' }).click();
  await expect(page.getByRole('status')).toContainText('Não achei a sala ZZZZ');
  await expect(page).toHaveURL(/\/$/);
});
