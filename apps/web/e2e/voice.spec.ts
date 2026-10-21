// The TV microphone's voice on the speakers: the Host turns it on (after a notice about directional microphones) and sets the volume.
import { expect, type Page, test } from '@playwright/test';
import { addToQueue, ANA, createRoom, hostPatch, roomState, SONGS } from './helpers.ts';

test.use({ viewport: { width: 390, height: 844 } });

const tvPlaying = (page: Page) => page.evaluate(() => window.tv.engine.playing && window.tv.engine.duration > 0 && window.tv.engine.currentTime > 0);
const voice = (page: Page) => page.evaluate(() => ({ attached: window.tv.engine.voiceAttached, gain: window.tv.engine.voiceGain }));
const voiceSwitch = (page: Page) => page.getByRole('switch', { name: /Voz do microfone nas caixas de som/ });

test('the Host turns the voice on: first the notice about directional microphones shows; "Agora não" leaves it off', async ({ page, request }) => {
  const room = await createRoom(request);
  await page.goto(room.hostUrl);
  const toggle = voiceSwitch(page);
  await expect(toggle).not.toBeChecked();
  await expect(page.getByLabel('Volume da voz nas caixas de som')).toHaveCount(0); // without the voice on there is no volume

  await toggle.click(); // (the click only opens the notice: the option changes after the confirmation)
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('microfones direcionais');
  await expect(dialog).toContainText('microfonia');
  await expect(dialog).toContainText('Comece com o volume baixo');
  await dialog.getByRole('button', { name: 'Agora não' }).click();
  await expect(dialog).toBeHidden();
  expect((await roomState(request, room.code)).voice).toBe(false);
  await expect(toggle).not.toBeChecked();

  await toggle.click(); // (the click only opens the notice: the option changes after the confirmation)
  await page.getByRole('dialog').getByRole('button', { name: 'Entendi, ligar a voz' }).click();
  await expect.poll(async () => (await roomState(request, room.code)).voice).toBe(true);
  await expect(toggle).toBeChecked();
  await expect(page.getByLabel('Volume da voz nas caixas de som')).toHaveValue('40'); // it starts low

  await toggle.click(); // turning it off asks nothing
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(async () => (await roomState(request, room.code)).voice).toBe(false);
});

test("whoever is not the Host does not see the voice's option", async ({ page, request }) => {
  const room = await createRoom(request);
  await page.goto(room.guestUrl);
  await expect(voiceSwitch(page)).toHaveCount(0);
});

test("the voice's volume goes to the Room when the bar is released", async ({ page, request }) => {
  const room = await createRoom(request);
  await hostPatch(request, room, { voice: true });
  await page.goto(room.hostUrl);
  const slider = page.getByLabel('Volume da voz nas caixas de som');
  await slider.focus();
  await slider.press('ArrowRight');
  await slider.press('ArrowRight'); // 40 → 50 → 60 (steps of 5... two arrows = 10)
  await slider.dispatchEvent('change');
  await expect.poll(async () => (await roomState(request, room.code)).voice_volume).toBeGreaterThan(40);
});

test('on the TV: with the voice on, the microphone goes to the output at the chosen volume, only while the song plays', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' });
  await page.goto(room.tvUrl);
  await expect.poll(() => tvPlaying(page)).toBe(true);
  expect(await voice(page)).toEqual({ attached: false, gain: 0 }); // off: the microphone is not even opened

  await hostPatch(request, room, { voice: true });
  await expect.poll(async () => (await voice(page)).attached).toBe(true);
  await expect.poll(async () => (await voice(page)).gain).toBeCloseTo(0.8, 5); // the default volume 40% → a gain of 0.8

  await hostPatch(request, room, { voice_volume: 100 });
  await expect.poll(async () => (await voice(page)).gain).toBeCloseTo(2, 5);
  await hostPatch(request, room, { voice_volume: 0 });
  await expect.poll(async () => (await voice(page)).gain).toBe(0);

  await hostPatch(request, room, { voice_volume: 50 });
  await expect.poll(async () => (await voice(page)).gain).toBeCloseTo(1, 5);
  await request.post(`/api/rooms/${room.code}/player/pause`, { headers: { 'x-client-id': ANA, 'x-host-token': room.host } });
  await expect.poll(async () => (await voice(page)).gain).toBe(0); // the song paused: the voice goes quiet (an open microphone standing still only howls)
  await request.post(`/api/rooms/${room.code}/player/resume`, { headers: { 'x-client-id': ANA, 'x-host-token': room.host } });
  await expect.poll(async () => (await voice(page)).gain).toBeCloseTo(1, 5);

  await hostPatch(request, room, { voice: false });
  await expect.poll(async () => (await voice(page)).attached).toBe(false); // turning it off lets the microphone go
});

test("feedback: a howl (a growing pure tone) cuts the voice's volume by itself, the TV warns, and the volume comes back later", async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' });
  await page.goto(room.tvUrl);
  await expect.poll(() => tvPlaying(page)).toBe(true);
  await hostPatch(request, room, { voice: true, voice_volume: 50 });
  await expect.poll(async () => (await voice(page)).attached).toBe(true);

  // a howl's spectrum: low noise and a narrow 2.4 kHz peak that rises every 50 ms frame
  const factor = await page.evaluate(() => {
    const engine = window.tv.engine;
    const bins = 1024;
    const bin = Math.round((2400 * 2 * bins) / engine.sampleRateForTests);
    for (let i = 0; i < 12; i++) {
      const s = new Float32Array(bins).fill(-80);
      s[bin] = -40 + i * 1.5;
      for (const [d, drop] of [[1, 12], [2, 26], [3, 45]]) { s[bin - d] = s[bin] - drop; s[bin + d] = s[bin] - drop; }
      engine.checkFeedback(s, i * 50);
    }
    return engine.voiceFactor;
  });
  expect(factor).toBeLessThan(1);
  await expect(page.getByText(/Microfonia detectada/)).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.tv.engine.voiceOutputGain), { timeout: 5000 }).toBeLessThan(0.6); // 50 % = a gain of 1; halved
});
