// Atraso do som e do microfone: a TV guarda o ajuste, a letra acompanha o que se ouve e a medição automática roda.
import { expect, test } from '@playwright/test';
import { addToQueue, ANA, createRoom, SONGS } from './helpers.mjs';

const tvPlaying = (page) => page.evaluate(() => window.tv.engine.playing && window.tv.engine.duration > 0 && window.tv.engine.currentTime > 1);

test('o ajuste do atraso do som atrasa a letra e a posição enviada aos celulares, e fica guardado', async ({ page, request }) => {
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
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('latency')))).toEqual({ output: 500, input: 0 });

  await dialog.getByRole('button', { name: 'Zerar' }).click();
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('latency')))).toEqual({ output: 0, input: 0 });
  await dialog.getByLabel(/Atraso do microfone/).fill('200');
  await dialog.getByLabel(/Atraso do som/).fill('300');
  await page.reload();
  await expect.poll(() => tvPlaying(page)).toBe(true);
  const gapAfter = await page.evaluate(() => window.tv.engine.currentTime - window.tv.engine.heardTime);
  expect(gapAfter).toBeGreaterThan(0.25); // guardado neste aparelho
});

test('medição automática: toca os estalos, escuta e mostra um resultado (ou o aviso de que não ouviu)', async ({ page, request }) => {
  test.setTimeout(60_000);
  const room = await createRoom(request);
  await page.goto(room.tvUrl);
  await page.keyboard.press('l'); // atalho da TV
  const dialog = page.getByRole('dialog', { name: 'Atraso do som e do microfone' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Medir automaticamente' }).click();
  await expect(dialog.getByText(/Tocando estalos/)).toBeVisible();
  await expect(dialog.getByText(/Atraso medido|Não ouvi os estalos/)).toBeVisible({ timeout: 30_000 });
});
