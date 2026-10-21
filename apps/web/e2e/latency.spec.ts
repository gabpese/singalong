// The sound's and the microphone's delay: the TV keeps the setting, the lyrics follow what is heard, and the automatic measurement runs.
import { expect, type Page, test } from '@playwright/test';
import { addToQueue, ANA, createRoom, SONGS } from './helpers.ts';

const tvPlaying = (page: Page) => page.evaluate(() => window.tv.engine.playing && window.tv.engine.duration > 0 && window.tv.engine.currentTime > 1);
const savedLatency = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('latency') ?? 'null'));

test("the sound's delay setting delays the lyrics and the position sent to the phones, and is kept", async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: ANA, name: 'Ana' });
  await page.goto(room.tvUrl);
  await expect.poll(() => tvPlaying(page)).toBe(true);

  await page.getByRole('button', { name: 'Atraso' }).click();
  const dialog = page.getByRole('dialog', { name: 'Atraso do som e do microfone' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel(/Atraso do som/).fill('500');
  await expect(dialog.getByText('Atraso do som (letra): 500 ms')).toBeVisible();
  const gap = await page.evaluate(() => window.tv.engine.currentTime - window.tv.engine.heardTime);
  expect(gap).toBeGreaterThan(0.45);
  expect(gap).toBeLessThan(0.55);
  expect(await savedLatency(page)).toEqual({ output: 500, input: 0 });

  await dialog.getByRole('button', { name: 'Zerar' }).click();
  expect(await savedLatency(page)).toEqual({ output: 0, input: 0 });
  await dialog.getByLabel(/Atraso do microfone/).fill('200');
  await dialog.getByLabel(/Atraso do som/).fill('300');
  await page.reload();
  await expect.poll(() => tvPlaying(page)).toBe(true);
  const gapAfter = await page.evaluate(() => window.tv.engine.currentTime - window.tv.engine.heardTime);
  expect(gapAfter).toBeGreaterThan(0.25); // kept on this device
});

test('the automatic measurement plays the clicks, listens and shows a result (or the notice that it heard nothing)', async ({ page, request }) => {
  test.setTimeout(60_000);
  const room = await createRoom(request);
  await page.goto(room.tvUrl);
  await page.keyboard.press('l'); // the TV's shortcut
  const dialog = page.getByRole('dialog', { name: 'Atraso do som e do microfone' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Medir automaticamente' }).click();
  await expect(dialog.getByText(/Tocando estalos/)).toBeVisible();
  await expect(dialog.getByText(/Atraso medido|Não ouvi os estalos/)).toBeVisible({ timeout: 30_000 });
});
