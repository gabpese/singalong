// Vários microfones na saída: a TV escolhe quais entram, cada um com a sua guarda de microfonia, somados num limitador.
import { expect, test } from '@playwright/test';
import { addToQueue, createRoom, hostPatch, SONGS } from './helpers.mjs';

const tvPlaying = (page) => page.evaluate(() => window.tv.engine.playing && window.tv.engine.duration > 0 && window.tv.engine.currentTime > 0);

test('sem escolha vale o microfone padrão; marcando dois, os dois entram na saída; desmarcando, volta a um', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' });
  await page.goto(room.tvUrl);
  await expect.poll(() => tvPlaying(page)).toBe(true);
  await hostPatch(request, room, { voice: true, voice_volume: 50 });
  await expect.poll(() => page.evaluate(() => window.tv.engine.voiceMics)).toBe(1); // o padrão

  await page.getByRole('button', { name: 'Microfones' }).click();
  const dialog = page.getByRole('dialog', { name: 'Microfones da TV' });
  const mics = dialog.locator('.mic-list').getByRole('checkbox');
  await expect(mics).toHaveCount(2); // os dois "Fake Audio Input" do Chromium de teste
  await mics.nth(0).check();
  await expect.poll(() => page.evaluate(() => window.tv.engine.voiceMics)).toBe(1);
  await mics.nth(1).check();
  await expect.poll(() => page.evaluate(() => window.tv.engine.voiceMics)).toBe(2);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('voiceMics')).length)).toBe(2);
  await expect(dialog.locator('small', { hasText: 'faz a pontuação' })).toHaveCount(1); // só o primeiro

  await mics.nth(0).uncheck();
  await expect.poll(() => page.evaluate(() => window.tv.engine.voiceMics)).toBe(1);
  await dialog.getByRole('button', { name: 'Fechar' }).click();

  await page.reload(); // a escolha fica guardada nesta TV
  await expect.poll(() => tvPlaying(page)).toBe(true);
  await expect.poll(() => page.evaluate(() => window.tv.engine.voiceMics)).toBe(1);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('voiceMics')).length)).toBe(1);
});

test('o apito de um microfone corta só o volume dele, e o aviso diz qual', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' });
  await page.goto(room.tvUrl);
  await expect.poll(() => tvPlaying(page)).toBe(true);
  await page.evaluate(async () => {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default');
    localStorage.setItem('voiceMics', JSON.stringify(devices.slice(0, 2).map((d) => ({ id: d.deviceId, label: d.label }))));
  });
  await page.reload();
  await expect.poll(() => tvPlaying(page)).toBe(true);
  await hostPatch(request, room, { voice: true, voice_volume: 50 });
  await expect.poll(() => page.evaluate(() => window.tv.engine.voiceMics)).toBe(2);

  const factors = await page.evaluate(() => {
    const engine = window.tv.engine;
    const bins = 1024;
    const bin = Math.round((2400 * 2 * bins) / engine.sampleRateForTests);
    for (let i = 0; i < 12; i++) {
      const s = new Float32Array(bins).fill(-80);
      s[bin] = -40 + i * 1.5;
      for (const [d, drop] of [[1, 12], [2, 26], [3, 45]]) { s[bin - d] = s[bin] - drop; s[bin + d] = s[bin] - drop; }
      engine.checkFeedback(s, i * 50, 1); // só o segundo microfone apita
    }
    return { second: engine.voiceFactor, first: engine.checkFeedback(new Float32Array(bins).fill(-80), 1000, 0).factor };
  });
  expect(factors.second).toBeLessThan(1);
  expect(factors.first).toBe(1); // o primeiro microfone segue normal
  await expect(page.getByText(/Microfonia no microfone 2/)).toBeVisible();
});

test('reduzir ruído e eco: vem ligado, o portão fecha no silêncio e abre com a voz, e dá para desligar (fica guardado)', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' });
  await page.goto(room.tvUrl);
  await expect.poll(() => tvPlaying(page)).toBe(true);
  await hostPatch(request, room, { voice: true, voice_volume: 50 });
  await expect.poll(() => page.evaluate(() => window.tv.engine.voiceMics)).toBe(1);
  expect(await page.evaluate(() => window.tv.engine.voiceFilter)).toBe(true); // ligado por padrão

  // o portão: silêncio fecha (só um fiozinho passa), voz abre; o ganho acompanha
  const closed = await page.evaluate(() => window.tv.engine.stepGate(0.0001, 100000)); // -80 dBFS
  expect(closed).toBeLessThan(0.2);
  await expect.poll(() => page.evaluate(() => window.tv.engine.voiceGateGain), { timeout: 5000 }).toBeLessThan(0.5);
  const open = await page.evaluate(() => window.tv.engine.stepGate(0.1, 100050)); // -20 dBFS: a voz entrou
  expect(open).toBe(1);
  await expect.poll(() => page.evaluate(() => window.tv.engine.voiceGateGain), { timeout: 5000 }).toBeGreaterThan(0.9);

  // desligar no diálogo: o portão deixa de fechar, na hora, e a escolha fica nesta TV
  await page.getByRole('button', { name: 'Microfones' }).click();
  const dialog = page.getByRole('dialog', { name: 'Microfones da TV' });
  const filter = dialog.getByRole('checkbox', { name: /Reduzir ruído e eco/ });
  await expect(filter).toBeChecked();
  await filter.uncheck();
  expect(await page.evaluate(() => window.tv.engine.voiceFilter)).toBe(false);
  expect(await page.evaluate(() => window.tv.engine.stepGate(0.0001, 300000))).toBe(1); // silêncio, mas o portão está desligado
  expect(await page.evaluate(() => localStorage.getItem('voiceFilter'))).toBe('off');
  await dialog.getByRole('button', { name: 'Fechar' }).click();
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.tv.engine.voiceFilter)).toBe(false); // continua desligado
});
