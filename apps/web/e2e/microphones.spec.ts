// Several microphones in the output: the TV picks which come in, each with its own feedback guard, summed into a limiter.
import { expect, type Page, test } from '@playwright/test';
import { addToQueue, createRoom, hostPatch, SONGS } from './helpers.ts';

const tvPlaying = (page: Page) => page.evaluate(() => window.tv.engine.playing && window.tv.engine.duration > 0 && window.tv.engine.currentTime > 0);
const voiceMics = (page: Page) => page.evaluate(() => window.tv.engine.voiceMics);
const savedMics = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('voiceMics') ?? '[]').length);

test('without a choice the default microphone counts; ticking two, both go to the output; unticking, it goes back to one', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' });
  await page.goto(room.tvUrl);
  await expect.poll(() => tvPlaying(page)).toBe(true);
  await hostPatch(request, room, { voice: true, voice_volume: 50 });
  await expect.poll(() => voiceMics(page)).toBe(1); // the default

  await page.getByRole('button', { name: 'Microfones' }).click();
  const dialog = page.getByRole('dialog', { name: 'Microfones da TV' });
  const mics = dialog.locator('.mic-list').getByRole('checkbox');
  await expect(mics).toHaveCount(2); // the test Chromium's two "Fake Audio Input"
  await mics.nth(0).check();
  await expect.poll(() => voiceMics(page)).toBe(1);
  await mics.nth(1).check();
  await expect.poll(() => voiceMics(page)).toBe(2);
  expect(await savedMics(page)).toBe(2);
  await expect(dialog.locator('small', { hasText: 'faz a pontuação' })).toHaveCount(1); // only the first

  await mics.nth(0).uncheck();
  await expect.poll(() => voiceMics(page)).toBe(1);
  await dialog.getByRole('button', { name: 'Fechar' }).click();

  await page.reload(); // the choice is kept on this TV
  await expect.poll(() => tvPlaying(page)).toBe(true);
  await expect.poll(() => voiceMics(page)).toBe(1);
  expect(await savedMics(page)).toBe(1);
});

test("one microphone's howl cuts only its own volume, and the notice says which", async ({ page, request }) => {
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
  await expect.poll(() => voiceMics(page)).toBe(2);

  const factors = await page.evaluate(() => {
    const engine = window.tv.engine;
    const bins = 1024;
    const bin = Math.round((2400 * 2 * bins) / engine.sampleRateForTests);
    for (let i = 0; i < 12; i++) {
      const s = new Float32Array(bins).fill(-80);
      s[bin] = -40 + i * 1.5;
      for (const [d, drop] of [[1, 12], [2, 26], [3, 45]]) { s[bin - d] = s[bin] - drop; s[bin + d] = s[bin] - drop; }
      engine.checkFeedback(s, i * 50, 1); // only the second microphone howls
    }
    return { second: engine.voiceFactor, first: engine.checkFeedback(new Float32Array(bins).fill(-80), 1000, 0).factor };
  });
  expect(factors.second).toBeLessThan(1);
  expect(factors.first).toBe(1); // the first microphone goes on as normal
  await expect(page.getByText(/Microfonia no microfone 2/)).toBeVisible();
});

test('reducing noise and echo: it comes on, the gate closes in silence and opens with the voice, and it can be turned off (and stays so)', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' });
  await page.goto(room.tvUrl);
  await expect.poll(() => tvPlaying(page)).toBe(true);
  await hostPatch(request, room, { voice: true, voice_volume: 50 });
  await expect.poll(() => voiceMics(page)).toBe(1);
  expect(await page.evaluate(() => window.tv.engine.voiceFilter)).toBe(true); // on by default

  // the gate: silence closes it (only a trickle passes), a voice opens it; the gain follows
  const closed = await page.evaluate(() => window.tv.engine.stepGate(0.0001, 100000)); // -80 dBFS
  expect(closed).toBeLessThan(0.2);
  await expect.poll(() => page.evaluate(() => window.tv.engine.voiceGateGain), { timeout: 5000 }).toBeLessThan(0.5);
  const open = await page.evaluate(() => window.tv.engine.stepGate(0.1, 100050)); // -20 dBFS: the voice came in
  expect(open).toBe(1);
  await expect.poll(() => page.evaluate(() => window.tv.engine.voiceGateGain), { timeout: 5000 }).toBeGreaterThan(0.9);

  // turning it off in the dialog: the gate stops closing, at once, and the choice stays on this TV
  await page.getByRole('button', { name: 'Microfones' }).click();
  const dialog = page.getByRole('dialog', { name: 'Microfones da TV' });
  const filter = dialog.getByRole('checkbox', { name: /Reduzir ruído e eco/ });
  await expect(filter).toBeChecked();
  await filter.uncheck();
  expect(await page.evaluate(() => window.tv.engine.voiceFilter)).toBe(false);
  expect(await page.evaluate(() => window.tv.engine.stepGate(0.0001, 300000))).toBe(1); // silence, but the gate is off
  expect(await page.evaluate(() => localStorage.getItem('voiceFilter'))).toBe('off');
  await dialog.getByRole('button', { name: 'Fechar' }).click();
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.tv.engine.voiceFilter)).toBe(false); // still off
});
