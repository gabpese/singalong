// Languages: the interface follows the chosen language (or the browser's) and remembers the choice.
import { expect, test } from '@playwright/test';
import { addToQueue, createRoom, SONGS } from './helpers.ts';

test('switching the language on the landing page translates it, and the choice holds in the Room', async ({ page, request }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Criar uma festa' })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Idioma' }).getByRole('button', { name: 'Português' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('group', { name: 'Idioma' }).getByRole('button', { name: 'English' }).click();
  await expect(page.getByRole('heading', { name: 'Start a party' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');

  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha);
  await page.goto(room.guestUrl);
  await expect(page.getByRole('tab', { name: 'TV' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
  await expect(page.getByRole('button', { name: /Queue/ })).toBeVisible();
  await page.getByRole('group', { name: 'Language' }).getByRole('button', { name: 'Español' }).click();
  await expect(page.getByRole('navigation', { name: 'Secciones' })).toBeVisible();
});

test('without a saved choice the browser decides: English on an English browser', async ({ browser }) => {
  const context = await browser.newContext({ locale: 'en-US' });
  const page = await context.newPage();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Join a room' })).toBeVisible();
  await context.close();
});

test("the language is picked by flags (Brazil, the United States and Spain), without its name written on screen", async ({ page }) => {
  await page.goto('/');
  const group = page.getByRole('group', { name: 'Idioma' });
  await expect(group.getByRole('button')).toHaveCount(3);
  for (const name of ['Português', 'English', 'Español']) {
    const flag = group.getByRole('button', { name });
    await expect(flag.locator('svg')).toBeVisible();
    await expect(flag).toHaveAttribute('title', name); // the name shows on hover
  }
  await expect(group).not.toContainText('English'); // nothing written, only the flags
});
