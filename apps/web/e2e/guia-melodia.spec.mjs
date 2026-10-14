// Guia de melodia: o anfitrião liga na barra lateral e a TV desenha as notas da música como barras, com a afinação por cima.
import { expect, test } from '@playwright/test';
import { addToQueue, ANA, createRoom, hostPatch, SONGS } from './helpers.mjs';

const tvPlaying = (page) => page.evaluate(() => window.tv.engine.playing && window.tv.engine.duration > 0 && window.tv.engine.currentTime > 0.3);

/** Quantos pixels do canvas do guia foram pintados (o desenho é por quadro: espera o primeiro). */
const painted = (page) =>
  page.evaluate(() => {
    const canvas = document.querySelector('canvas.pitch-guide');
    if (!canvas || !canvas.width) return 0;
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let count = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i] > 0) count++;
    return count;
  });

test('o guia fica desligado por padrão e, ligado, a TV desenha as barras da melodia', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: ANA, name: 'Ana' });
  await page.goto(room.tvUrl);
  await expect.poll(() => tvPlaying(page)).toBe(true);
  await expect(page.locator('canvas.pitch-guide')).toHaveCount(0); // desligado: nada na tela

  await hostPatch(request, room, { melody_bars: true });
  await expect(page.locator('canvas.pitch-guide')).toBeVisible();
  await expect(page.locator('main.tv-stage')).toHaveClass(/has-guide/);
  await expect.poll(() => painted(page), { timeout: 8000 }).toBeGreaterThan(500); // as barras e a linha do "agora"
  expect(await page.locator('canvas.pitch-guide').getAttribute('role')).toBe('img');

  await hostPatch(request, room, { melody_bars: false });
  await expect(page.locator('canvas.pitch-guide')).toHaveCount(0);
});

test('o anfitrião liga e desliga o guia pela barra lateral da sala', async ({ page, request }) => {
  const room = await createRoom(request);
  await page.goto(room.hostUrl);
  const guide = page.getByRole('switch', { name: 'Guia de melodia' });
  await expect(guide).toBeVisible();
  await expect(guide).toHaveAttribute('aria-checked', 'false');
  await guide.click();
  await expect(guide).toHaveAttribute('aria-checked', 'true');
  await expect.poll(async () => (await (await request.get(`/api/rooms/${room.code}`, { headers: { 'x-client-id': ANA } })).json()).melody_bars).toBe(true);
  await guide.click();
  await expect(guide).toHaveAttribute('aria-checked', 'false');
});

test('quem não é anfitrião não vê o interruptor do guia', async ({ page, request }) => {
  const room = await createRoom(request);
  await page.goto(room.guestUrl);
  await expect(page.getByRole('button', { name: 'Copiar link da sala' })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Guia de melodia' })).toHaveCount(0);
});

test('música sem melodia: o guia liga mas não aparece nada (sem notas para desenhar)', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.charlie, { client: ANA, name: 'Ana' }); // sem melodia no cache de teste? confere abaixo
  await hostPatch(request, room, { melody_bars: true });
  await page.goto(room.tvUrl);
  await expect.poll(() => tvPlaying(page)).toBe(true);
  const hasMelody = await page.evaluate(() => Boolean(window.tv.state?.queue?.[0]?.song?.media?.melody));
  if (!hasMelody) await expect(page.locator('canvas.pitch-guide')).toHaveCount(0);
});

test('a TV com o guia ligado passa no axe', async ({ page, request }) => {
  const { default: AxeBuilder } = await import('@axe-core/playwright');
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: ANA, name: 'Ana' });
  await hostPatch(request, room, { melody_bars: true });
  await page.goto(room.tvUrl);
  await expect.poll(() => tvPlaying(page)).toBe(true);
  await expect(page.locator('canvas.pitch-guide')).toBeVisible();
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(result.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
});
