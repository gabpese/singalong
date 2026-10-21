// The Room's TV tab: whoever joins by the QR code lands in the Room and can go to the TV just to watch (no sound and no microphone).
import { expect, type Page, test } from '@playwright/test';
import { addToQueue, ANA, BIA, createRoom, SONGS } from './helpers.ts';

test.use({ viewport: { width: 390, height: 844 } });

const tvPlaying = (page: Page) => page.evaluate(() => window.tv.engine.playing && window.tv.engine.duration > 0 && window.tv.engine.currentTime > 0);

test('the guest switches between the Room and the TV, sees the lyrics and the Queue on the TV, and plays no sound', async ({ browser, page: tv, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: ANA, name: 'Ana' });
  await addToQueue(request, room.code, SONGS.bravo, { client: BIA, name: 'Bia' });
  await tv.goto(room.tvUrl);
  await expect.poll(() => tvPlaying(tv)).toBe(true);

  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(() => localStorage.setItem('clientId', 'client-caio-0001'));
  const guest = await context.newPage();
  await guest.goto(room.guestUrl);

  // joins the Room (the Room tab), and the TV is a choice
  await expect(guest.getByRole('tab', { name: 'Sala' })).toHaveAttribute('aria-selected', 'true');
  await guest.getByRole('tab', { name: /TV/ }).click();
  await expect(guest.getByRole('tab', { name: /TV/ })).toHaveAttribute('aria-selected', 'true');
  await expect(guest.locator('.tv-viewer .singer.is-now')).toContainText('Ana');
  await expect(guest.locator('.tv-viewer .singer.is-next')).toContainText('Bia');
  await expect(guest.locator('.tv-viewer .line.current')).toContainText('Primeira linha da letra');
  await expect(guest.locator('.tv-viewer .tv-queue')).toContainText('Bia');

  // only watching: no audio playing on this device
  expect(await guest.evaluate(() => [...document.querySelectorAll('audio')].every((a) => a.paused))).toBe(true);

  // back to the Room
  await guest.getByRole('tab', { name: 'Sala' }).click();
  await expect(guest.locator('.tv-viewer')).toHaveCount(0);
  await expect(guest.getByRole('button', { name: /Adicionar/ })).toBeVisible();
  await context.close();
});
