// Reações dos celulares: um toque manda um aplauso, fogo... que sobe pela TV, pela aba TV da sala e pelo palco do cantor.
import { expect, test } from '@playwright/test';
import { addToQueue, ANA, BIA, createRoom, SONGS } from './helpers.mjs';

const tvPlaying = (page) => page.evaluate(() => window.tv.engine.playing && window.tv.engine.duration > 0 && window.tv.engine.currentTime > 0);

/** Uma pessoa no celular, com o nome dela (é o que aparece junto da reação). */
async function phone(browser, client, name) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(([id, who]) => {
    localStorage.setItem('clientId', id);
    localStorage.setItem('userName', who);
  }, [client, name]);
  return { context, page: await context.newPage() };
}

test('um toque no celular faz a reação subir pela TV, com o nome de quem mandou', async ({ browser, page: tv, request }) => {
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
  expect(await tv.locator('.reaction-layer').getAttribute('aria-hidden')).toBe('true'); // decoração: o leitor de tela não lê
  await bia.page.getByRole('button', { name: 'Fogo' }).click();
  await expect(tv.locator('.reaction', { hasText: '🔥' })).toHaveCount(1);
  // some sozinha depois de subir
  await expect(tv.locator('.reaction')).toHaveCount(0, { timeout: 6000 });
  await bia.context.close();
});

test('quem aperta sem parar é limitado: a TV não vira uma nuvem de emojis', async ({ browser, page: tv, request }) => {
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
  // o balde do servidor começa com 6 fichas e enche 3 por segundo: num computador lento os cliques levam mais tempo e passam mais reações
  expect(shown).toBeLessThanOrEqual(Math.ceil(6 + 3 * (seconds + 0.5)) + 1);
  expect(shown).toBeLessThan(30);
  await bia.context.close();
});

test('a aba TV da sala e o palco do cantor também veem as reações', async ({ browser, page: tv, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: ANA, name: 'Ana' }); // a música da Ana: ela vai para o palco
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

  await expect(ana.page.locator('.reaction', { hasText: '❤️' })).toHaveCount(1); // no palco
  await expect(caio.page.locator('.reaction', { hasText: '❤️' })).toHaveCount(1); // na aba TV
  await expect(caio.page.getByRole('group', { name: 'Reações' })).toBeVisible(); // e dá para reagir de lá também
  for (const p of [ana, caio, bia]) await p.context.close();
});
