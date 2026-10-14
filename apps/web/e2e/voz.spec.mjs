// A voz do microfone da TV nas caixas: o anfitrião liga (depois de um aviso sobre microfones direcionais) e ajusta o volume.
import { expect, test } from '@playwright/test';
import { addToQueue, ANA, createRoom, hostPatch, roomState, SONGS } from './helpers.mjs';

test.use({ viewport: { width: 390, height: 844 } });

const tvPlaying = (page) => page.evaluate(() => window.tv.engine.playing && window.tv.engine.duration > 0 && window.tv.engine.currentTime > 0);
const voice = (page) => page.evaluate(() => ({ attached: window.tv.engine.voiceAttached, gain: window.tv.engine.voiceGain }));
const voiceSwitch = (page) => page.getByRole('switch', { name: /Voz do microfone nas caixas de som/ });

test('o anfitrião liga a voz: antes aparece o aviso dos microfones direcionais; "Agora não" deixa desligada', async ({ page, request }) => {
  const room = await createRoom(request);
  await page.goto(room.hostUrl);
  const toggle = voiceSwitch(page);
  await expect(toggle).not.toBeChecked();
  await expect(page.getByLabel('Volume da voz nas caixas de som')).toHaveCount(0); // sem a voz ligada não há volume

  await toggle.click(); // (o clique só abre o aviso: a opção muda depois da confirmação)
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('microfones direcionais');
  await expect(dialog).toContainText('microfonia');
  await expect(dialog).toContainText('Comece com o volume baixo');
  await dialog.getByRole('button', { name: 'Agora não' }).click();
  await expect(dialog).toBeHidden();
  expect((await roomState(request, room.code)).voice).toBe(false);
  await expect(toggle).not.toBeChecked();

  await toggle.click(); // (o clique só abre o aviso: a opção muda depois da confirmação)
  await page.getByRole('dialog').getByRole('button', { name: 'Entendi, ligar a voz' }).click();
  await expect.poll(async () => (await roomState(request, room.code)).voice).toBe(true);
  await expect(toggle).toBeChecked();
  await expect(page.getByLabel('Volume da voz nas caixas de som')).toHaveValue('40'); // começa baixo

  await toggle.click(); // desligar não pergunta nada
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect.poll(async () => (await roomState(request, room.code)).voice).toBe(false);
});

test('quem não é anfitrião não vê a opção da voz', async ({ page, request }) => {
  const room = await createRoom(request);
  await page.goto(room.guestUrl);
  await expect(voiceSwitch(page)).toHaveCount(0);
});

test('o volume da voz vai para a sala ao soltar a barra', async ({ page, request }) => {
  const room = await createRoom(request);
  await hostPatch(request, room, { voice: true });
  await page.goto(room.hostUrl);
  const slider = page.getByLabel('Volume da voz nas caixas de som');
  await slider.focus();
  await slider.press('ArrowRight');
  await slider.press('ArrowRight'); // 40 → 50 → 60 (passos de 5... duas setas = 10)
  await slider.dispatchEvent('change');
  await expect.poll(async () => (await roomState(request, room.code)).voice_volume).toBeGreaterThan(40);
});

test('na TV: com a voz ligada o microfone entra na saída com o volume escolhido, só enquanto a música toca', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' });
  await page.goto(room.tvUrl);
  await expect.poll(() => tvPlaying(page)).toBe(true);
  expect(await voice(page)).toEqual({ attached: false, gain: 0 }); // desligada: o microfone nem é aberto

  await hostPatch(request, room, { voice: true });
  await expect.poll(async () => (await voice(page)).attached).toBe(true);
  await expect.poll(async () => (await voice(page)).gain).toBeCloseTo(0.8, 5); // volume padrão 40% → ganho 0,8

  await hostPatch(request, room, { voice_volume: 100 });
  await expect.poll(async () => (await voice(page)).gain).toBeCloseTo(2, 5);
  await hostPatch(request, room, { voice_volume: 0 });
  await expect.poll(async () => (await voice(page)).gain).toBe(0);

  await hostPatch(request, room, { voice_volume: 50 });
  await expect.poll(async () => (await voice(page)).gain).toBeCloseTo(1, 5);
  await request.post(`/api/rooms/${room.code}/player/pause`, { headers: { 'x-client-id': ANA, 'x-host-token': room.host } });
  await expect.poll(async () => (await voice(page)).gain).toBe(0); // música pausada: a voz cala (microfone aberto parado só dá microfonia)
  await request.post(`/api/rooms/${room.code}/player/resume`, { headers: { 'x-client-id': ANA, 'x-host-token': room.host } });
  await expect.poll(async () => (await voice(page)).gain).toBeCloseTo(1, 5);

  await hostPatch(request, room, { voice: false });
  await expect.poll(async () => (await voice(page)).attached).toBe(false); // desligar solta o microfone
});

test('microfonia: um apito (tom puro que cresce) corta o volume da voz sozinho, a TV avisa e o volume volta depois', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' });
  await page.goto(room.tvUrl);
  await expect.poll(() => tvPlaying(page)).toBe(true);
  await hostPatch(request, room, { voice: true, voice_volume: 50 });
  await expect.poll(async () => (await voice(page)).attached).toBe(true);

  // um espectro de apito: ruído baixo e um pico estreito de 2,4 kHz que sobe a cada quadro de 50 ms
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
  await expect.poll(() => page.evaluate(() => window.tv.engine.voiceOutputGain), { timeout: 5000 }).toBeLessThan(0.6); // 50 % = ganho 1; cortado pela metade
});
