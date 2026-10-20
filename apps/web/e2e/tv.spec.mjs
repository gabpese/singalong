import { expect, test } from '@playwright/test';
import { addToQueue, ANA, BIA, createRoom, hostPatch, roomState, SONGS } from './helpers.mjs';

const hostPost = (request, room, path, data) =>
  request.post(`/api/rooms/${room.code}${path}`, { headers: { 'x-client-id': ANA, 'x-host-token': room.host }, data });
// tocando de verdade: o áudio já carregou (duração conhecida) e o relógio andou; só `playing` vale assim que o play() é chamado
/** Bichinhos cortados: para cada um, os elementos acima dele que cortam o que transborda precisam conter o desenho inteiro. */
const clippedBlobs = (page) =>
  page.evaluate(() => {
    const out = [];
    for (const blob of document.querySelectorAll('.singer-blobs .blob')) {
      // o bicho que respira (SVG em linha) passa do próprio quadro: o SVG não pode cortar o que transborda
      if (blob.tagName.toLowerCase() === 'svg' && getComputedStyle(blob).overflow !== 'visible') out.push('svg.blob');
      const box = blob.getBoundingClientRect();
      for (let el = blob.parentElement; el && el !== document.body; el = el.parentElement) {
        const style = getComputedStyle(el);
        if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
        const clip = el.getBoundingClientRect();
        if (box.top < clip.top - 1 || box.bottom > clip.bottom + 1 || box.left < clip.left - 1 || box.right > clip.right + 1) out.push(el.className);
      }
    }
    return out;
  });
const playing = (page) => page.evaluate(() => window.tv.engine.playing && window.tv.engine.duration > 0 && window.tv.engine.currentTime > 0);

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
  await expect(page.locator('.idle')).toBeHidden(); // a tela de espera sai

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
  await expect(page.locator('.score-hud small strong').first()).toBeVisible(); // as notas em negrito

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

test('o QR code da sala continua na TV com a música tocando (ao lado de quem está cantando)', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: ANA, name: 'Ana' });
  await page.goto(room.tvUrl);
  await expect.poll(() => page.evaluate(() => window.tv.engine.playing)).toBe(true);
  const card = page.getByRole('complementary', { name: 'Entrar na sala' });
  await expect(card).toBeVisible();
  await expect(card.getByLabel('QR code para entrar na sala').locator('svg')).toBeVisible();
  await expect(page.locator('.room-tag')).toContainText(room.code); // o código escrito continua no cabeçalho
  await expect(page.locator('.singer.is-now')).toBeVisible();
});

test('pontuação e guia de melodia estão marcados como beta (interruptores, guia e quadro da TV)', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: ANA, name: 'Ana' });
  await hostPatch(request, room, { scoring: true, melody_bars: true });
  await page.goto(room.hostUrl);
  await expect(page.getByRole('switch', { name: 'Pontuação pelo microfone (beta)' })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Guia de melodia (beta)' })).toBeVisible();
  const tv = await page.context().newPage();
  await tv.goto(room.tvUrl);
  await expect.poll(() => tv.evaluate(() => window.tv.engine.playing)).toBe(true);
  await expect(tv.locator('.score-hud .beta-tag')).toBeVisible();
  await expect(tv.locator('.guide-card .beta-tag')).toBeVisible();
  await expect(tv.locator('.guide-card .beta-tag')).toHaveAttribute('title', /ainda não é totalmente fiel/);
});

test('sala de espera: "Aguardando cantores" com o QR code no centro e os celulares que entram aparecem em tempo real', async ({ browser, page, request }) => {
  const room = await createRoom(request);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(room.tvUrl);
  await expect(page.getByRole('heading', { name: 'Aguardando cantores…' })).toBeVisible();
  await expect(page.getByText('Ninguém conectado ainda')).toBeVisible();
  await expect(page.locator('.slot.free')).toHaveCount(4); // vagas livres enquanto ninguém entra

  // o QR code fica no centro do painel de vidro, e o painel no centro da tela
  const qr = await page.locator('.lobby-qr').boundingBox();
  const lobby = await page.locator('.lobby').boundingBox();
  expect(Math.abs(qr.x + qr.width / 2 - (lobby.x + lobby.width / 2))).toBeLessThanOrEqual(2);
  expect(Math.abs(lobby.x + lobby.width / 2 - 1280 / 2)).toBeLessThanOrEqual(2);

  // um celular entra pelo código: o avatar com o nome aparece na TV sem recarregar
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(() => {
    localStorage.setItem('clientId', 'client-lobby-0001');
    localStorage.setItem('userName', 'Marina');
  });
  const phone = await context.newPage();
  await phone.goto(room.guestUrl);
  await expect(page.locator('.slot.filled')).toContainText('Marina');
  await expect(page.locator('.slot.filled svg.blob')).toBeVisible(); // o bichinho (blobatar) feito a partir do nome
  await expect(page.getByText('1 cantor conectado')).toBeVisible();

  // e sai quando o celular fecha
  await context.close();
  await expect(page.locator('.slot.filled')).toHaveCount(0);
  await expect(page.getByText('Ninguém conectado ainda')).toBeVisible();
});

test('sala de espera: não há limite de cantores; passando de 7, o último lugar mostra quantos faltam', async ({ page, request }) => {
  const room = await createRoom(request);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(room.tvUrl);
  // dez celulares conectados (o mesmo WebSocket da sala que o celular abre)
  await page.evaluate((code) => {
    window.phones = Array.from({ length: 10 }, (_, i) =>
      new WebSocket(`ws://${location.host}/api/rooms/ws?code=${code}&role=controller&client=lobby-phone-${i}&name=Pessoa${i}`));
  }, room.code);
  await expect(page.getByText('10 cantores conectados')).toBeVisible();
  await expect(page.locator('.slot.filled')).toHaveCount(6);
  await expect(page.locator('.slot.more')).toContainText('+4');
  await expect(page.locator('.slot.free')).toHaveCount(0);
  // a fileira cabe no cartaz e o cartaz cabe na tela
  const sheet = await page.locator('.lobby-sheet').boundingBox();
  const slots = await page.locator('.lobby-slots').boundingBox();
  expect(slots.x).toBeGreaterThanOrEqual(sheet.x);
  expect(slots.x + slots.width).toBeLessThanOrEqual(sheet.x + sheet.width);
  expect(sheet.y + sheet.height).toBeLessThanOrEqual(720);
});

test('o bichinho de quem canta aparece ao lado do nome; num dueto aceito aparecem os dois', async ({ browser, page, request }) => {
  const room = await createRoom(request);
  await page.setViewportSize({ width: 1280, height: 720 });
  // a Bia está na sala (um celular conectado), para poder ser convidada
  await page.goto(room.tvUrl);
  await page.evaluate((code) => {
    window.bia = new WebSocket(`ws://${location.host}/api/rooms/ws?code=${code}&role=controller&client=client-bia-0001&name=Bia`);
  }, room.code);
  await expect.poll(async () => (await roomState(request, room.code)).people.length).toBe(1);
  const itemId = await addToQueue(request, room.code, SONGS.alpha, { client: ANA, name: 'Ana' });
  await expect(page.locator('.singer.is-now .who')).toContainText('Ana');
  await expect(page.locator('.singer.is-now .singer-blobs .blob')).toHaveCount(1);
  await expect(page.locator('.tv-queue .is-current .singer-blobs .blob')).toHaveCount(1);

  const { pid } = (await roomState(request, room.code)).people[0];
  await request.post(`/api/rooms/${room.code}/queue/${itemId}/invite`, { headers: { 'x-client-id': ANA }, data: { pid } });
  await request.post(`/api/rooms/${room.code}/queue/${itemId}/invite/respond`, { headers: { 'x-client-id': BIA }, data: { accept: true } });
  await expect(page.locator('.singer.is-now .who')).toContainText('Ana & Bia');
  await expect(page.locator('.singer.is-now .singer-blobs.duo .blob')).toHaveCount(2);
  await expect(page.locator('.tv-queue .is-current .singer-blobs .blob')).toHaveCount(2);
  expect(await clippedBlobs(page)).toEqual([]); // nenhum bichinho cortado pela altura da linha do nome
  // o nome do dueto aparece inteiro (quebra em duas linhas se precisar, em vez de virar "…")
  expect(await page.locator('.singer.is-now .who-name').evaluate((el) => el.scrollHeight - el.clientHeight < parseFloat(getComputedStyle(el).lineHeight) / 2 && el.scrollWidth <= el.clientWidth + 1)).toBe(true);

  // no celular, a música tocando e a fila também mostram os dois
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await phone.addInitScript(() => { localStorage.setItem('clientId', 'client-caio-0001'); localStorage.setItem('userName', 'Caio'); });
  const caio = await phone.newPage();
  await caio.goto(room.guestUrl);
  await expect(caio.locator('.now-singer .singer-blobs.duo img.blob')).toHaveCount(2);
  expect(await clippedBlobs(caio)).toEqual([]);
  await phone.close();
});
