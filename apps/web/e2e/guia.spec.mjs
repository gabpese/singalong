// Voz original (guia para cantar): o controle no celular e a TV tocando a voz original junto do instrumental.
import { expect, test } from '@playwright/test';
import { addToQueue, ANA, BIA, createRoom, roomState, SONGS } from './helpers.mjs';

const slider = (page) => page.getByRole('slider', { name: 'Volume da voz original, como guia para cantar' });
const itemOf = async (request, room, song) => (await roomState(request, room.code)).queue.find((i) => i.video_id === song.id);
const setGuide = (request, room, itemId, level, client = ANA) =>
  request.patch(`/api/rooms/${room.code}/queue/${itemId}`, { headers: { 'x-client-id': client }, data: { guide: level } });
const engine = (page) => page.evaluate(() => ({
  level: window.tv.engine.guideLevel,
  has: window.tv.engine.hasGuide,
  playing: window.tv.engine.guidePlaying,
  drift: Math.abs(window.tv.engine.guideTime - window.tv.engine.currentTime),
}));

test.describe('celular', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('a barra só aparece nas músicas que têm a voz original, para quem as escolheu', async ({ page, request }) => {
    const room = await createRoom(request);
    await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' }); // tem a voz
    await addToQueue(request, room.code, SONGS.charlie, { name: 'Ana' }); // não tem
    await page.addInitScript((id) => localStorage.setItem('clientId', id), ANA);
    await page.goto(room.guestUrl);
    await expect(page.locator('.now').getByRole('slider', { name: 'Volume da voz original, como guia para cantar' })).toBeVisible();
    await expect(page.locator('.queue-item', { hasText: 'Rolling in the Deep' }).getByRole('slider', { name: 'Volume da voz original, como guia para cantar' })).toHaveCount(0);
  });

  test('arrastar a barra manda o nível para a sala sem mexer nas vozes de apoio', async ({ page, request }) => {
    const room = await createRoom(request);
    const id = await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' });
    await page.addInitScript((c) => localStorage.setItem('clientId', c), ANA);
    await page.goto(room.guestUrl);
    await expect(slider(page)).toHaveValue('0'); // padrão: desligada
    await slider(page).fill('45');
    await expect.poll(async () => (await itemOf(request, room, SONGS.alpha)).guide).toBe(45);
    expect((await itemOf(request, room, SONGS.alpha)).backing).toBe(0);
    await setGuide(request, room, id, 80);
    await expect(slider(page)).toHaveValue('80');
  });

  test('quem não escolheu a música só vê o valor', async ({ page, request }) => {
    const room = await createRoom(request);
    const id = await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' });
    await setGuide(request, room, id, 60);
    await page.addInitScript((c) => localStorage.setItem('clientId', c), BIA);
    await page.goto(room.guestUrl);
    await expect(page.getByText('Voz original (guia) 60%')).toBeVisible();
    await expect(slider(page)).toHaveCount(0);
  });
});

test.describe('TV', () => {
  const play = async (page, request, level) => {
    const room = await createRoom(request);
    const id = await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' });
    if (level) await setGuide(request, room, id, level);
    await page.goto(room.tvUrl);
    await expect.poll(() => page.evaluate(() => window.tv.engine.playing && window.tv.engine.currentTime > 0.3)).toBe(true);
    return { room, id };
  };

  test('com o nível em 0 a voz original não toca (nem é baixada)', async ({ page, request }) => {
    await play(page, request, 0);
    expect(await engine(page)).toMatchObject({ level: 0, has: true, playing: false });
  });

  test('com o nível acima de 0 a voz original toca junto, no mesmo ponto do instrumental', async ({ page, request }) => {
    await play(page, request, 55);
    await expect.poll(async () => (await engine(page)).playing).toBe(true);
    const state = await engine(page);
    expect(state.level).toBe(55);
    expect(state.drift).toBeLessThan(0.3);
  });

  test('mudar o nível no meio da música liga e desliga a voz original, e ela convive com as vozes de apoio', async ({ page, request }) => {
    const { room, id } = await play(page, request, 0);
    await setGuide(request, room, id, 70);
    await expect.poll(async () => (await engine(page)).playing).toBe(true);
    await request.patch(`/api/rooms/${room.code}/queue/${id}`, { headers: { 'x-client-id': ANA }, data: { backing: 50 } });
    await expect.poll(() => page.evaluate(() => window.tv.engine.backingPlaying)).toBe(true);
    expect((await engine(page)).playing).toBe(true);
    await setGuide(request, room, id, 0);
    await expect.poll(async () => (await engine(page)).playing).toBe(false);
    expect(await page.evaluate(() => window.tv.engine.backingPlaying)).toBe(true); // o apoio segue
  });

  test('música sem a voz original: nada a tocar mesmo com nível definido', async ({ page, request }) => {
    const room = await createRoom(request);
    const id = await addToQueue(request, room.code, SONGS.charlie, { name: 'Ana' });
    await setGuide(request, room, id, 90);
    await page.goto(room.tvUrl);
    await expect.poll(() => page.evaluate(() => window.tv.engine.playing && window.tv.engine.currentTime > 0.3)).toBe(true);
    expect(await engine(page)).toMatchObject({ has: false, playing: false });
  });
});
