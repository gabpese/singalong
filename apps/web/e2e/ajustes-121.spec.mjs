// Ajustes da 1.2.1: a letra não passa por cima da outra, a que já passou some, a pontuação fica à direita (fora do guia de
// melodia), a barra lateral fica abaixo do topo e o volume da voz só aparece quando se procura por ele.
import { expect, test } from '@playwright/test';
import { addToQueue, ANA, BIA, createRoom, hostPatch, SONGS } from './helpers.mjs';

const tvPlaying = (page) => page.evaluate(() => window.tv.engine.playing && window.tv.engine.duration > 0 && window.tv.engine.currentTime > 1.2);
const box = (locator) => locator.evaluate((el) => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom }; });
const overlap = (a, b) => a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom;

test('a letra se ajusta ao cartão: nenhuma linha passa por cima da outra, mesmo com a fonte grande e a tela pequena', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: ANA, name: 'Ana' });
  await page.addInitScript(() => localStorage.setItem('lyricsScale', '1.8'));
  await page.setViewportSize({ width: 560, height: 380 });
  await page.goto(room.tvUrl);
  await expect.poll(() => tvPlaying(page)).toBe(true);
  await expect(page.locator('.line.current')).toContainText('Segunda linha cantada agora');
  await page.waitForTimeout(400);
  const lines = await Promise.all(['.line.current', '.line.next', '.line.next2'].map((selector) => box(page.locator(selector))));
  for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) if (lines[i].h > 0 && lines[j].h > 0) expect(overlap(lines[i], lines[j]), `linhas ${i} e ${j} se sobrepõem`).toBe(false);
  expect(await page.locator('.lyrics').evaluate((el) => el.scrollHeight <= el.clientHeight + 1)).toBe(true); // tudo cabe no cartão
});

test('a letra que já passou fica apagada (baixa opacidade) e a que vem fica num branco sutil', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: ANA, name: 'Ana' });
  await page.goto(room.tvUrl);
  await expect.poll(() => tvPlaying(page)).toBe(true);
  await expect(page.locator('.line.current')).toContainText('Segunda linha cantada agora');
  const opacity = (selector) => page.locator(selector).evaluate((el) => Number(getComputedStyle(el).opacity));
  expect(await opacity('.line.prev')).toBeLessThan(0.5); // a linha que passou perde a força
  expect(await opacity('.line.next')).toBe(1); // a que vem não perde opacidade: a cor é um branco translúcido
  const color = await page.locator('.line.next').evaluate((el) => getComputedStyle(el).color);
  expect(color).toMatch(/^rgba\(255, 255, 255, 0\.\d+\)$/);
});

test('a pontuação fica na extrema direita e não cobre o guia de melodia', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: ANA, name: 'Ana' });
  await hostPatch(request, room, { scoring: true, melody_bars: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(room.tvUrl);
  await expect.poll(() => tvPlaying(page)).toBe(true);
  await expect(page.locator('canvas.pitch-guide')).toBeVisible();
  const hud = await box(page.locator('.score-hud'));
  const guide = await box(page.locator('canvas.pitch-guide'));
  expect(hud.right).toBeGreaterThan(1280 - 48); // colado na direita
  expect(overlap(hud, guide)).toBe(false); // o guia termina antes do cartão
  expect(guide.w).toBeGreaterThan(700); // e continua largo
});

test('sem o guia de melodia o cartão da pontuação também fica à direita', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: ANA, name: 'Ana' });
  await hostPatch(request, room, { scoring: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(room.tvUrl);
  await expect(page.locator('.score-hud')).toBeVisible();
  expect((await box(page.locator('.score-hud'))).right).toBeGreaterThan(1280 - 48);
});

test.describe('sala no computador', () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  test('o seletor de idioma não estica o topo e a barra lateral fica abaixo dele', async ({ page, request }) => {
    const room = await createRoom(request);
    await page.goto(room.hostUrl);
    const header = await box(page.locator('header.topbar'));
    const select = await box(page.locator('header.topbar .language-switch'));
    const rail = await box(page.locator('aside.room-rail'));
    expect(select.w).toBeLessThan(260); // antes ocupava o topo inteiro
    expect(header.h).toBeLessThan(110);
    expect(rail.y).toBeGreaterThanOrEqual(header.bottom - 1); // a barra não fica atrás do topo
  });

  test('o volume da voz ao lado do interruptor só aparece com o mouse em cima (e não fica aberto depois do clique)', async ({ page, request }) => {
    const room = await createRoom(request);
    await hostPatch(request, room, { voice: true });
    await page.goto(room.hostUrl);
    const popup = page.locator('.rail-pop');
    const voiceSwitch = page.getByRole('switch', { name: /Voz do microfone/ });
    await expect(voiceSwitch).toBeVisible();
    await page.mouse.move(700, 500);
    await expect(popup).toHaveCSS('opacity', '0');
    await voiceSwitch.hover();
    await expect(popup).toHaveCSS('opacity', '1');
    const pop = await box(popup);
    const sw = await box(voiceSwitch);
    expect(Math.abs((pop.y + pop.h / 2) - (sw.y + sw.h / 2))).toBeLessThan(8); // centrado no interruptor
    await page.mouse.move(900, 600);
    await expect(popup).toHaveCSS('opacity', '0');
  });
});

// a janela do app do dono é bem menor que uma TV: nada pode ficar por cima de nada
for (const size of [{ width: 1100, height: 740 }, { width: 1100, height: 800 }, { width: 1280, height: 720 }, { width: 1366, height: 768 }, { width: 1920, height: 1080 }, { width: 1000, height: 600 }, { width: 960, height: 560 }]) {
  test(`com o guia e a pontuação ligados, nenhum cartão se sobrepõe a outro (${size.width}x${size.height})`, async ({ page, request }) => {
    const room = await createRoom(request);
    // a fila cheia: a música que toca e mais sete esperando (a coluna da direita fica no máximo de altura)
    const songs = [SONGS.alpha, SONGS.bravo, SONGS.charlie, SONGS.delta];
    for (let i = 0; i < 8; i++) await addToQueue(request, room.code, songs[i % 4], { client: i % 2 ? ANA : BIA, name: i % 2 ? 'Ana' : 'Bia' });
    await hostPatch(request, room, { scoring: true, melody_bars: true });
    await page.setViewportSize(size);
    await page.goto(room.tvUrl);
    await expect.poll(() => tvPlaying(page)).toBe(true);
    await expect(page.locator('canvas.pitch-guide')).toBeVisible();
    await expect(page.locator('.score-hud')).toBeVisible();
    await page.waitForTimeout(300);
    const cards = {
      lyrics: await box(page.locator('.lyrics')),
      queue: await box(page.locator('.tv-queue')),
      qr: await box(page.locator('.tv-join')),
      singer: await box(page.locator('.singer.is-now')),
      guide: await box(page.locator('canvas.pitch-guide')),
      hud: await box(page.locator('.score-hud')),
      progress: await box(page.locator('.tv-progress')),
    };
    const names = Object.keys(cards);
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) expect(overlap(cards[names[i]], cards[names[j]]), `${names[i]} sobre ${names[j]}`).toBe(false);
    }
    expect(cards.hud.right).toBeGreaterThan(size.width - 48); // continua colado na direita
    expect(cards.hud.bottom).toBeLessThanOrEqual(size.height); // e cabe na tela
    expect(cards.qr.bottom).toBeLessThanOrEqual(size.height); // o QR code também cabe na tela
    expect(cards.qr.bottom).toBeLessThanOrEqual(cards.lyrics.y + 1); // o QR code fica no alto, ao lado de quem canta, e não sobre a letra
    expect(cards.qr.right).toBeLessThanOrEqual(cards.singer.x + 1); // à esquerda do "Cantando agora"
    expect(cards.queue.x).toBeGreaterThanOrEqual(cards.lyrics.right); // a fila ocupa sozinha a coluna ao lado da letra
    expect(cards.queue.y).toBeLessThanOrEqual(cards.lyrics.y + 40);
    expect(cards.queue.bottom).toBeLessThanOrEqual(cards.hud.y + 1); // e termina antes da faixa de baixo
  });
}
