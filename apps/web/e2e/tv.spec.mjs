import { expect, test } from '@playwright/test';
import { addToQueue, ANA, BIA, createRoom, hostPatch, roomState, SONGS } from './helpers.mjs';

const hostPost = (request, room, path, data) =>
  request.post(`/api/rooms/${room.code}${path}`, { headers: { 'x-client-id': ANA, 'x-host-token': room.host }, data });
const playing = (page) => page.evaluate(() => window.tv.engine.playing);

test('sem sala na URL a TV avisa', async ({ page }) => {
  await page.goto('/tv.html');
  await expect(page.getByRole('status')).toContainText('Abra a TV a partir de uma sala');
});

test('sala que não existe: aviso na TV', async ({ page }) => {
  await page.goto('/tv.html?room=ZZZZ');
  await expect(page.getByRole('status')).toContainText('Sala não encontrada');
});

test('sem música: tela de espera com o código, o QR code e o link da sala', async ({ page, request }) => {
  const room = await createRoom(request);
  await page.goto(room.tvUrl);
  await expect(page).toHaveTitle(`Singalong — TV ${room.code}`);
  await expect(page.getByText(`Entre na sala ${room.code} pelo celular`)).toBeVisible();
  await expect(page.getByLabel('QR code para entrar na sala').locator('svg')).toBeVisible();
  await expect(page.getByText(`/room.html?room=${room.code}`)).toBeVisible();
  await expect(page.getByText('Adicione músicas pelo celular para começar.')).toBeVisible();
  await expect(page.locator('.room-tag')).toHaveText(`Sala ${room.code}`);
  await expect(page.getByRole('button', { name: 'Tela cheia' })).toBeVisible();
});

test('na tela de espera mostra qual é a próxima música quando ainda está preparando', async ({ page, request }) => {
  const room = await createRoom(request);
  await request.post(`/api/rooms/${room.code}/queue`, {
    headers: { 'x-client-id': ANA },
    data: { url: 'https://youtu.be/dQw4w9WgXcQ', name: 'Ana', artist: 'Rick', title: 'Never', lyrics: { source: 'none' } },
  });
  await page.goto(room.tvUrl);
  await expect(page.getByText(/Próximo: Ana — Never \(preparando…\)/)).toBeVisible();
});

test('toca: mostra quem canta, o tom, a fila, a letra sincronizada e a barra de progresso', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' });
  await addToQueue(request, room.code, SONGS.bravo, { client: BIA, name: 'Bia' });
  await page.goto(room.tvUrl);

  await expect(page.getByText('Cantando agora')).toBeVisible();
  await expect(page.locator('.singer.is-now')).toContainText('Ana');
  await expect(page.locator('.singer.is-now')).toContainText('Wicked Game — Stone Sour');
  await expect(page.locator('.singer.is-now .key')).toContainText('Ré♯');
  await expect(page.locator('.singer.is-next')).toContainText('Bia');
  await expect(page.locator('.singer.is-next')).toContainText('Unethical');
  await expect(page.getByLabel('Fila de cantores')).toContainText('Ana');
  await expect(page.getByLabel('Fila de cantores')).toContainText('Bia');
  await expect(page.getByText('Entre na sala')).toBeHidden(); // a tela de espera sai

  await expect.poll(() => playing(page)).toBe(true);
  // a letra acompanha o relógio: a 1ª linha entra em ~1 s e a 2ª em ~5 s
  await expect(page.locator('.line.current')).toContainText('Primeira linha da letra');
  await expect(page.locator('.line.next')).toContainText('Segunda linha cantada agora');
  // palavras preenchidas com o tempo de cada uma (--p vai de 0 a 100%)
  await expect.poll(() => page.locator('.line.current .w').evaluateAll((els) => els.filter((e) => parseFloat(e.style.getPropertyValue('--p')) > 0).length)).toBeGreaterThan(0);
  await expect.poll(() => page.locator('.tv-progress > div').evaluate((el) => parseFloat(el.style.width))).toBeGreaterThan(0);
  // a TV conectada aparece para os celulares
  await expect.poll(async () => (await roomState(request, room.code)).tv_connected).toBe(true);
});

test('pausar e retomar pelo anfitrião param e voltam o som da TV', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' });
  await page.goto(room.tvUrl);
  await expect.poll(() => playing(page)).toBe(true);
  await hostPost(request, room, '/player/pause');
  await expect.poll(() => playing(page)).toBe(false);
  await hostPost(request, room, '/player/resume');
  await expect.poll(() => playing(page)).toBe(true);
});

test('o tom escolhido chega ao motor de áudio e o ajuste da letra também', async ({ page, request }) => {
  const room = await createRoom(request);
  const itemId = await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana', pitch: 2 });
  await page.goto(room.tvUrl);
  await expect.poll(() => page.evaluate(() => window.tv.engine.pitch)).toBe(2);
  await request.patch(`/api/rooms/${room.code}/queue/${itemId}`, { headers: { 'x-client-id': ANA }, data: { pitch: -3 } });
  await expect.poll(() => page.evaluate(() => window.tv.engine.pitch)).toBe(-3);
  await request.put(`/api/rooms/${room.code}/songs/${SONGS.alpha.id}/offset`, { headers: { 'x-client-id': ANA, 'x-host-token': room.host }, data: { offset: 1.5 } });
  await expect.poll(() => page.evaluate(() => window.tv.engine.offset)).toBe(1.5);
});

test('voltar e avançar 10 s: a TV executa o salto', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' });
  await page.goto(room.tvUrl);
  await expect.poll(() => playing(page)).toBe(true);
  const before = await page.evaluate(() => window.tv.engine.currentTime);
  await hostPost(request, room, '/player/seek', { seconds: 10 });
  await expect.poll(() => page.evaluate(() => window.tv.engine.currentTime)).toBeGreaterThan(before + 9);
  const after = await page.evaluate(() => window.tv.engine.currentTime);
  await hostPost(request, room, '/player/seek', { seconds: -10 });
  await expect.poll(() => page.evaluate(() => window.tv.engine.currentTime)).toBeLessThan(after - 9);
});

test('pular passa para a próxima; a música que termina também passa sozinha', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' });
  await addToQueue(request, room.code, SONGS.bravo, { client: BIA, name: 'Bia' });
  await addToQueue(request, room.code, SONGS.charlie, { client: ANA, name: 'Ana' });
  await page.goto(room.tvUrl);
  await expect(page.locator('.singer.is-now')).toContainText('Wicked Game');
  await hostPost(request, room, '/player/skip');
  await expect(page.locator('.singer.is-now')).toContainText('Unethical');
  await expect(page.locator('.singer.is-now')).toContainText('Bia');
  await expect.poll(() => playing(page)).toBe(true);
  // perto do fim: o áudio acaba, a TV avisa e a sala passa para a próxima
  await hostPost(request, room, '/player/seek', { seconds: 28 });
  await expect(page.locator('.singer.is-now')).toContainText('Rolling in the Deep', { timeout: 15_000 });
  expect((await roomState(request, room.code)).queue.map((i) => i.video_id)).toEqual([SONGS.charlie.id]);
});

test('fila vazia depois da última música: volta para a tela de espera', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' });
  await page.goto(room.tvUrl);
  await expect(page.locator('.singer.is-now')).toBeVisible();
  await hostPost(request, room, '/player/skip');
  await expect(page.getByText(`Entre na sala ${room.code} pelo celular`)).toBeVisible();
  await expect(page.locator('.singer.is-now')).toBeHidden();
});

test('TV recarregada no meio da música retoma de onde estava', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' });
  await page.goto(room.tvUrl);
  await expect.poll(() => playing(page)).toBe(true);
  await hostPost(request, room, '/player/seek', { seconds: 12 });
  await expect.poll(async () => (await roomState(request, room.code)).position_ms, { timeout: 10_000 }).toBeGreaterThan(10_000);
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.tv.engine.currentTime), { timeout: 10_000 }).toBeGreaterThan(10);
});

test('pontuação: o quadro mostra a nota original e a cantada e a nota final vai para o placar', async ({ page, request }) => {
  test.setTimeout(60_000);
  const room = await createRoom(request);
  await hostPatch(request, room, { scoring: true });
  await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' });
  await page.goto(room.tvUrl);
  await expect(page.locator('.score-hud')).toBeVisible();
  await expect(page.locator('.score-hud')).toContainText('Pontuação');
  await expect(page.locator('.score-hud small')).toContainText(/Original: [A-G]#?\d/);
  await expect(page.locator('.score-hud small')).toContainText('Você:');
  await expect(page.locator('.score-hud small b').first()).toBeVisible(); // as notas em negrito

  // 10 s no fim da música: tempo de sobra para a nota valer (mínimo de 5 s com voz na original)
  await hostPost(request, room, '/player/seek', { seconds: 20 });
  await expect(page.locator('.score-final')).toBeVisible({ timeout: 25_000 });
  await expect(page.locator('.score-final')).toContainText('Pontuação final');
  await expect(page.locator('.score-final strong')).toHaveText(/^\d+$/);
  await expect(page.locator('.score-final')).toContainText('Ana');
  await expect.poll(async () => (await roomState(request, room.code)).scoreboard.length).toBe(1);
});

test('sem pontuação ligada o quadro não aparece', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' });
  await page.goto(room.tvUrl);
  await expect(page.locator('.singer.is-now')).toBeVisible();
  await expect(page.locator('.score-hud')).toBeHidden();
});
