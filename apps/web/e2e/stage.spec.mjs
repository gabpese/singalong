// Palco: na vez da música de um cantor, o celular dele vai da sala para o palco (letra no ritmo da TV) e volta quando ela acaba.
import { expect, test } from '@playwright/test';
import { addToQueue, ANA, BIA, createRoom, publishLocalSong, SONGS, startAgentSession } from './helpers.mjs';

test.use({ viewport: { width: 390, height: 844 } });

const MEDIA_BASE = 'http://127.0.0.1:3101/e2e';
const LOCAL = { id: 'localStage1', title: 'Tempo Perdido', artist: 'Legião Urbana' };

/** Uma pessoa no celular: o navegador dela tem o próprio client_id (é por ele que a sala sabe de quem é a música). */
async function phone(browser, client) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript((id) => localStorage.setItem('clientId', id), client);
  return { context, page: await context.newPage() };
}

const tvPlaying = (page) => page.evaluate(() => window.tv.engine.playing && window.tv.engine.duration > 0 && window.tv.engine.currentTime > 0);
const hostPost = (request, room, path) => request.post(`/api/rooms/${room.code}${path}`, { headers: { 'x-client-id': ANA, 'x-host-token': room.host } });

test('na vez da música dele o cantor vai para o palco, vê a letra no ritmo da TV e volta à sala quando acaba', async ({ browser, page: tv, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: ANA, name: 'Ana' });
  await tv.goto(room.tvUrl);
  await expect.poll(() => tvPlaying(tv)).toBe(true);

  const ana = await phone(browser, ANA);
  await ana.page.goto(room.guestUrl);
  await expect(ana.page).toHaveURL(new RegExp(`/stage\\.html\\?room=${room.code}`)); // redirecionada da sala para o palco
  await expect(ana.page.getByRole('heading', { name: 'Wicked Game' })).toBeVisible();
  await expect(ana.page.locator('.stage-where')).toContainText(`Sala ${room.code}`);
  await expect(ana.page.locator('.stage-artist')).toContainText('Ana');
  await expect(ana.page.locator('.line.current')).toContainText('Primeira linha da letra'); // a letra anda com a música da TV
  await expect(ana.page.locator('.line.next')).toContainText('Segunda linha cantada agora');
  await expect.poll(() => ana.page.locator('.line.current .w').evaluateAll((els) => els.filter((e) => parseFloat(e.style.getPropertyValue('--p')) > 0).length)).toBeGreaterThan(0);

  // o anfitrião pula: o palco mostra o fim e devolve a Ana à sala
  await hostPost(request, room, '/player/skip');
  await expect(ana.page.getByText('Acabou!')).toBeVisible();
  await expect(ana.page).toHaveURL(new RegExp(`/room\\.html\\?room=${room.code}`), { timeout: 10_000 });
  await ana.context.close();
});

test('quem não é o cantor da vez fica na sala, e sem TV conectada ninguém é levado ao palco', async ({ browser, page: tv, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: ANA, name: 'Ana' });

  const ana = await phone(browser, ANA);
  await ana.page.goto(room.guestUrl);
  await expect(ana.page.getByText('Wicked Game').first()).toBeVisible();
  await ana.page.waitForTimeout(800);
  expect(ana.page.url()).toContain('/room.html'); // a TV ainda não está conectada: nada de palco

  await tv.goto(room.tvUrl);
  await expect.poll(() => tvPlaying(tv)).toBe(true);
  await expect(ana.page).toHaveURL(/\/stage\.html/); // com a TV tocando, a Ana vai para o palco

  const bia = await phone(browser, BIA);
  await bia.page.goto(room.guestUrl);
  await expect(bia.page.getByText('Wicked Game').first()).toBeVisible();
  await bia.page.waitForTimeout(800);
  expect(bia.page.url()).toContain('/room.html'); // a Bia não canta agora: continua na sala
  await ana.context.close();
  await bia.context.close();
});

test('"Voltar à sala" sai do palco e a sala não leva o cantor de volta nesta música', async ({ browser, page: tv, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: ANA, name: 'Ana' });
  await addToQueue(request, room.code, SONGS.bravo, { client: ANA, name: 'Ana' });
  await tv.goto(room.tvUrl);
  await expect.poll(() => tvPlaying(tv)).toBe(true);

  const ana = await phone(browser, ANA);
  await ana.page.goto(room.guestUrl);
  await expect(ana.page).toHaveURL(/\/stage\.html/);
  await ana.page.getByRole('button', { name: 'Voltar à sala' }).click();
  await expect(ana.page).toHaveURL(/\/room\.html/);
  await ana.page.waitForTimeout(1200);
  expect(ana.page.url()).toContain('/room.html'); // não volta para o palco enquanto a mesma música toca

  await hostPost(request, room, '/player/skip'); // a próxima música também é da Ana: aí sim ela é levada ao palco
  await expect(ana.page).toHaveURL(/\/stage\.html/, { timeout: 10_000 });
  await expect(ana.page.getByRole('heading', { name: 'Unethical' })).toBeVisible();
  await ana.context.close();
});

test('quem abre o palco sem ser a vez dele volta direto para a sala', async ({ browser, request }) => {
  const room = await createRoom(request);
  const bia = await phone(browser, BIA);
  await bia.page.goto(`/stage.html?room=${room.code}`);
  await expect(bia.page).toHaveURL(/\/room\.html/);
  await bia.context.close();
});

test('com a música no computador do dono a letra chega ao palco repassada pela TV', async ({ browser, page: tv, request }) => {
  await request.post('/__test/seed-song', { data: LOCAL });
  const { headers, room, tvUrl, guestUrl } = await startAgentSession(request, 'Dona Flor', MEDIA_BASE);
  await publishLocalSong(request, headers, LOCAL);
  const added = await request.post(`/api/rooms/${room.code}/queue`, { headers: { 'x-client-id': ANA }, data: { video_id: LOCAL.id, name: 'Ana' } });
  expect(added.status(), await added.text()).toBe(201);
  await tv.goto(tvUrl);
  await expect.poll(() => tvPlaying(tv)).toBe(true);

  const ana = await phone(browser, ANA);
  const lyricRequests = [];
  ana.page.on('request', (req) => { if (req.url().includes('lyrics.json')) lyricRequests.push(req.url()); });
  await ana.page.goto(guestUrl);
  await expect(ana.page).toHaveURL(/\/stage\.html/);
  await expect(ana.page.locator('.line.current')).toContainText('Primeira linha da letra');
  expect(lyricRequests).toEqual([]); // o celular nunca alcança o servidor local de mídia: a letra veio pela TV
  await ana.context.close();
  await request.post('/__test/remove-song', { data: { id: LOCAL.id } });
});

test('música sem dueto: a letra não ganha nenhum dono de linha (nem o ponto colorido do dueto)', async ({ browser, page: tv, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: ANA, name: 'Ana' });
  await tv.goto(room.tvUrl);
  await expect.poll(() => tvPlaying(tv)).toBe(true);
  await expect(tv.locator('.line.next')).toContainText('Segunda linha');
  expect(await tv.locator('.lyrics [data-part]').count()).toBe(0); // nenhum atributo, então nenhum ponto
  const ana = await phone(browser, ANA);
  await ana.page.goto(room.guestUrl);
  await expect(ana.page.locator('.line.current')).toContainText('Primeira linha da letra');
  expect(await ana.page.locator('.stage-lyrics [data-part]').count()).toBe(0);
  await ana.context.close();
});
