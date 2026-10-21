import { expect, type Page, test } from '@playwright/test';
import { addToQueue, ANA, BIA, createRoom, hostPatch, roomState, SONGS } from './helpers.ts';

test.use({ viewport: { width: 390, height: 844 } });

const queueItem = (page: Page, title: string) => page.locator('.queue-item', { hasText: title });
const tab = (page: Page, name: string | RegExp) => page.getByRole('navigation', { name: 'Seções' }).getByRole('button', { name });
const toast = (page: Page) => page.locator('.toast');

test('a Room without a code goes back to the landing page; a Room that does not exist shows the notice', async ({ page }) => {
  await page.goto('/room.html');
  await expect(page).toHaveURL(/\/$/);
  await page.goto('/room.html?room=ZZZZ');
  await expect(page.getByRole('heading', { name: 'Sala não encontrada' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Criar uma nova sala' })).toBeVisible();
});

test("shows the code, the TV's state and the empty Queue", async ({ page, request }) => {
  const room = await createRoom(request);
  await page.goto(room.guestUrl);
  await expect(page).toHaveTitle(`Singalong — Sala ${room.code}`);
  await expect(page.getByRole('heading', { name: `Sala ${room.code}` })).toBeVisible();
  await expect(page.getByText('TV desconectada')).toBeVisible();
  await expect(page.getByText('Nada tocando.')).toBeVisible();
  await expect(page.getByText('Ninguém na fila.')).toBeVisible();
});

test('the TV opening changes the state to "TV conectada"', async ({ page, context, request }) => {
  const room = await createRoom(request);
  await page.goto(room.guestUrl);
  await expect(page.getByText('TV desconectada')).toBeVisible();
  const tv = await context.newPage();
  await tv.goto(room.tvUrl);
  await expect(page.getByText('TV conectada', { exact: true })).toBeVisible();
  await tv.close();
  await expect(page.getByText('TV desconectada')).toBeVisible();
});

test('the Jukebox lists the ready songs, filters by artist and name, and adds to the Queue', async ({ page, request }) => {
  const room = await createRoom(request);
  await page.goto(room.guestUrl);
  await tab(page, 'Jukebox').click();
  const library = page.locator('.library li');
  await expect(library).toHaveCount(4);
  await expect(page.getByRole('heading', { name: /Jukebox/ })).toContainText('(4)');

  const filter = page.getByLabel('Filtrar o Jukebox');
  await filter.fill('faouzia');
  await expect(library).toHaveCount(2);
  await expect(library.first()).toContainText('Unethical');
  await expect(page.getByRole('heading', { name: /Jukebox/ })).toContainText('(2 de 4)');

  await filter.fill('nada disso existe');
  await expect(page.getByText('Nenhuma música encontrada para “nada disso existe”.')).toBeVisible();
  await page.getByRole('button', { name: 'Limpar filtro' }).click();
  await expect(library).toHaveCount(4);

  await page.getByLabel('Seu nome').isHidden(); // the name field is on the "Adicionar" tab
  await library.filter({ hasText: 'Rolling in the Deep' }).getByRole('button', { name: 'Adicionar' }).click();
  await expect(toast(page)).toContainText('Adicionada à fila!');
  await tab(page, 'Fila').click();
  await expect(page.getByRole('heading', { name: 'Tocando agora' })).toBeVisible();
  await expect(page.locator('.now-content').first()).toContainText('Rolling in the Deep');
  expect((await roomState(request, room.code)).queue.map((i) => i.video_id)).toEqual([SONGS.charlie.id]);
});

test('what plays now and the Queue: who sings, the next one and the count', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: ANA, name: 'Ana' });
  await addToQueue(request, room.code, SONGS.bravo, { client: BIA, name: 'Bia' });
  await page.goto(room.guestUrl);
  await expect(page.getByText('Ana está cantando')).toBeVisible();
  await expect(page.getByText('Letra: buscada na internet')).toBeVisible();
  await expect(page.getByText('Próximo: Bia')).toBeVisible();
  await expect(queueItem(page, 'Unethical')).toBeVisible();
  await expect(queueItem(page, 'Unethical')).toContainText('Bia');
  await expect(queueItem(page, 'Unethical')).toContainText('Próximo');
  await expect(page.getByRole('heading', { name: /Na fila/ })).toContainText('(1)');
  await expect(tab(page, /Fila/)).toContainText('(2)');
  await expect(page.getByText('A TV não está conectada')).toBeVisible();
});

test('the Host: pausing, resuming and skipping, with the icon buttons', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' });
  await addToQueue(request, room.code, SONGS.bravo, { client: BIA, name: 'Bia' });
  await page.goto(room.hostUrl);
  await page.getByRole('button', { name: 'Pausar' }).click();
  await expect(page.getByRole('button', { name: 'Retomar' })).toBeVisible();
  expect((await roomState(request, room.code, { host: room.host })).playback).toBe('paused');
  await expect(page.getByRole('button', { name: 'Retomar' }).locator('.icon.i-resume')).toBeVisible(); // the icon changes with the state
  await page.getByRole('button', { name: 'Retomar' }).click();
  await expect(page.getByRole('button', { name: 'Pausar' }).locator('.icon.i-pause')).toBeVisible();
  // the 10 s buttons gave way to the position bar
  await expect(page.getByRole('button', { name: 'Voltar 10 segundos' })).toHaveCount(0);
  await expect(page.getByRole('slider', { name: 'Posição da música' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Pular' }).locator('.icon.i-next-song')).toBeVisible();
  await page.getByRole('button', { name: 'Pular' }).click();
  await expect(page.getByText('Bia está cantando')).toBeVisible();
  await expect(page.getByText('Ninguém na fila.')).toBeVisible();
});

test('the position bar: the Host drags it and the TV goes to that point; the others only follow', async ({ page, browser, context, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' });
  const tv = await context.newPage();
  await tv.goto(room.tvUrl);
  await expect.poll(() => tv.evaluate(() => window.tv.engine.playing && window.tv.engine.currentTime > 0)).toBe(true);
  await page.goto(room.hostUrl);

  const slider = page.getByRole('slider', { name: 'Posição da música' });
  await expect(slider).toHaveAttribute('max', '30'); // the test song's duration
  await slider.fill('20'); // dragging and dropping at 0:20
  await expect(page.locator('.progress .time')).toContainText(/0:2\d \/ 0:30/); // the target shows at once (and it keeps playing from there)
  await expect.poll(() => tv.evaluate(() => window.tv.engine.currentTime)).toBeGreaterThan(19);
  await slider.fill('3'); // going back works too
  await expect.poll(() => tv.evaluate(() => window.tv.engine.currentTime)).toBeLessThan(10);
  // the bar follows the song again, from the new point
  await expect.poll(async () => Number(await slider.inputValue())).toBeLessThan(15);

  // whoever is not the Host sees the bar, without being able to drag it
  const guest = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  await guest.goto(room.guestUrl);
  await expect(guest.locator('.progress .bar')).toBeVisible();
  await expect(guest.getByRole('slider', { name: 'Posição da música' })).toHaveCount(0);
});

test("the key's buttons and the preview use plus and minus icons", async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' });
  await page.goto(room.hostUrl);
  const pitch = page.locator('.now .pitch');
  await expect(pitch.getByRole('button', { name: 'Mais grave' }).locator('.icon.i-minus')).toBeVisible();
  await expect(pitch.getByRole('button', { name: 'Mais agudo' }).locator('.icon.i-plus')).toBeVisible();
});

test("the Host: the lyrics' offset, the key, moving and removing in the Queue", async ({ page, request }) => {
  const room = await createRoom(request);
  // the lyrics' offset is kept per song (it holds in any Room): it starts from zero, not from what another test left
  await request.put(`/api/rooms/${room.code}/songs/${SONGS.alpha.id}/offset`, { headers: { 'x-client-id': ANA, 'x-host-token': room.host }, data: { offset: 0 } });
  await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' });
  await addToQueue(request, room.code, SONGS.bravo, { client: BIA, name: 'Bia' });
  await addToQueue(request, room.code, SONGS.charlie, { client: BIA, name: 'Bia' });
  await page.goto(room.hostUrl);

  await expect(page.getByText('Ajuste da letra')).toBeVisible();
  await page.getByRole('button', { name: '+0.5 s' }).click();
  await expect(page.getByText('0,5 s', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '−0.1 s' }).click();
  await expect(page.getByText('0,4 s', { exact: true })).toBeVisible();

  // the key of the song playing
  await expect(page.locator('.now .pitch-value')).toContainText('Tom original');
  await page.locator('.now .pitch').getByRole('button', { name: 'Mais agudo' }).click();
  await expect(page.locator('.now .pitch')).toHaveAttribute('data-pitch', '1');
  await expect(page.locator('.now .pitch-caption')).toHaveText('Mais agudo');

  // the order: Unethical, Rolling in the Deep; moving the second one up
  const items = page.locator('.queue-item');
  await expect(items.nth(0)).toContainText('Unethical');
  await expect(items.nth(0).getByRole('button', { name: 'Subir na fila' })).toBeDisabled();
  await items.nth(1).getByRole('button', { name: 'Subir na fila' }).click();
  await expect(items.nth(0)).toContainText('Rolling in the Deep');
  await items.nth(0).getByRole('button', { name: 'Descer na fila' }).click();
  await expect(items.nth(0)).toContainText('Unethical');

  await items.nth(0).getByRole('button', { name: 'Remover da fila' }).click();
  await expect(items).toHaveCount(1);
  await expect(items.first()).toContainText('Rolling in the Deep');
});

test("the fair rotation and scoring: only the Host sees and turns them on; the Queue shows the rotation's order", async ({ page, browser, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' });
  await addToQueue(request, room.code, SONGS.bravo, { name: 'Ana' });
  await addToQueue(request, room.code, SONGS.charlie, { client: BIA, name: 'Bia' });
  await page.goto(room.hostUrl);
  await page.getByRole('switch', { name: /Rodízio justo/ }).click();
  await expect(page.getByRole('switch', { name: /Rodízio justo/ })).toBeChecked();
  expect((await roomState(request, room.code)).fair).toBe(true);
  // with the rotation, Bia sings before Ana's 2nd song, and moving up and down are disabled
  const items = page.locator('.queue-item');
  await expect(items.nth(0)).toContainText('Rolling in the Deep');
  await expect(items.nth(1)).toContainText('Unethical');
  await expect(items.nth(0).getByRole('button', { name: 'Descer na fila' })).toBeDisabled();

  await page.getByRole('switch', { name: /Pontuação pelo microfone/ }).click();
  await expect.poll(async () => (await roomState(request, room.code)).scoring).toBe(true);
  await expect(page.getByRole('heading', { name: 'Placar' })).toBeVisible();

  const guest = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage(); // another browser: without the token
  await guest.goto(room.guestUrl);
  await expect(guest.getByRole('button', { name: 'Copiar link da sala' })).toBeVisible(); // the Room's link is everyone's
  await expect(guest.getByRole('switch')).toHaveCount(0);
  await expect(guest.getByRole('button', { name: 'Copiar link de anfitrião' })).toHaveCount(0);
  await expect(guest.getByRole('button', { name: 'Abrir TV' })).toHaveCount(0);
});

test('whoever is not the Host touches only their own songs and can give up their turn', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: BIA, name: 'Bia' });
  await addToQueue(request, room.code, SONGS.bravo, { client: ANA, name: 'Ana' });
  await addToQueue(request, room.code, SONGS.charlie, { client: BIA, name: 'Bia' });
  // the test's browser is Ana (the same client id that added "Unethical")
  await page.addInitScript((id) => localStorage.setItem('clientId', id), ANA);
  await page.goto(room.guestUrl);
  await expect(page.getByRole('button', { name: 'Pausar' })).toBeHidden();
  await expect(page.getByText('Ajuste da letra')).toBeHidden();
  const mine = queueItem(page, 'Unethical');
  const others = queueItem(page, 'Rolling in the Deep');
  await expect(mine.getByRole('button', { name: 'Remover da fila' })).toBeVisible();
  await expect(others.getByRole('button', { name: 'Remover da fila' })).toBeHidden();
  await expect(others.getByRole('button', { name: 'Mais agudo' })).toBeHidden();
  await mine.getByRole('button', { name: 'Ceder a vez' }).click();
  await expect(toast(page)).toContainText('Você cedeu a vez');
  await expect(page.locator('.queue-item').nth(0)).toContainText('Rolling in the Deep');
  await expect(page.locator('.queue-item').nth(1)).toContainText('Unethical');
});

test('adding a song: searching YouTube, choosing the video and putting it in the Queue', async ({ page, request }) => {
  await request.post('/__test/search-results', {
    data: [
      { video_id: 'newVideo001', title: 'Billie Eilish - bad guy (Official)', channel: 'Billie Eilish', duration: 190 },
      { video_id: 'newVideo002', title: 'bad guy (cover)', channel: 'Someone', duration: 200 },
    ],
  });
  const room = await createRoom(request);
  await page.goto(room.guestUrl);
  await tab(page, 'Adicionar').click();

  await page.getByLabel('Seu nome').fill('Carla');
  // without the artist and the name it does not search
  await page.getByRole('button', { name: 'Buscar no YouTube' }).click();
  await expect(page.getByText('Informe o artista ou o nome da música')).toBeVisible();

  await page.getByLabel('Artista').fill('Billie Eilish');
  await page.getByLabel('Nome da música').fill('Bad Guy');
  await page.getByRole('button', { name: 'Buscar no YouTube' }).click();
  await expect(page.locator('.results .result')).toHaveCount(2);
  await expect(page.getByText('Toque no vídeo certo.')).toBeVisible();

  await page.locator('.results .result').first().click();
  await expect(page.getByText('Selecionado: Billie Eilish - bad guy (Official)')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Ouvir no YouTube' })).toBeVisible();
  await expect(page.locator('.results')).toBeHidden();

  await page.getByRole('combobox', { name: 'Letra' }).selectOption('none');
  await expect(page.getByText('Toca só o instrumental')).toBeVisible();
  await page.getByRole('button', { name: 'Adicionar à fila' }).click();

  await expect(toast(page).or(page.getByRole('status').filter({ hasText: 'Adicionada à fila' })).first()).toBeVisible();
  await tab(page, 'Fila').click();
  await expect.poll(async () => (await roomState(request, room.code)).queue.length).toBe(1);
  const state = await roomState(request, room.code);
  expect(state.queue[0]).toMatchObject({ video_id: 'newVideo001', added_by: 'Carla', title: 'Bad Guy', artist: 'Billie Eilish' });
  await expect(page.locator('.now, .queue-item').filter({ hasText: 'Carla' }).first()).toBeVisible();
});

test('adding a song: a pasted link, lyrics to paste, and errors', async ({ page, request }) => {
  const room = await createRoom(request);
  await page.goto(room.guestUrl);
  await tab(page, 'Adicionar').click();
  await page.getByLabel('Seu nome').fill('Carla'); // the name is required to add
  await page.getByText('Já tenho o link do vídeo').click();
  await page.getByLabel('Link do vídeo do YouTube').fill('https://youtu.be/dQw4w9WgXcQ?si=x');
  await expect(page.getByText('Link reconhecido: dQw4w9WgXcQ')).toBeVisible();
  await page.getByLabel('Link do vídeo do YouTube').fill('junk');
  await expect(page.getByText('Link reconhecido')).toBeHidden();

  const source = page.getByRole('combobox', { name: 'Letra' });
  await expect(page.getByLabel('Letra', { exact: true }).and(page.locator('textarea'))).toBeHidden();
  await source.selectOption('align');
  await expect(page.locator('textarea[aria-label="Letra"]')).toBeVisible();
  await source.selectOption('lrclib');
  await expect(page.locator('textarea[aria-label="Letra"]')).toBeHidden();

  // the pasted lyrics go to the job with the song
  await page.getByLabel('Artista').fill('A');
  await page.getByLabel('Nome da música').fill('B');
  await page.getByLabel('Link do vídeo do YouTube').fill('https://youtu.be/dQw4w9WgXcQ');
  await source.selectOption('align');
  await page.locator('textarea[aria-label="Letra"]').fill('a single line');
  await page.getByRole('button', { name: 'Adicionar à fila' }).click();
  await tab(page, 'Fila').click();
  await expect.poll(async () => (await roomState(request, room.code)).queue.length).toBe(1);
  expect((await request.get('/__test/state').then((r) => r.json())).queue.at(-1).payload).toMatchObject({ lyrics_source: 'align', lyrics_text: 'a single line' });
});

test('a song still being prepared and a song that asks for lyrics show with the right notice', async ({ page, request }) => {
  const room = await createRoom(request);
  await request.post(`/api/rooms/${room.code}/queue`, {
    headers: { 'x-client-id': ANA },
    data: { url: 'https://youtu.be/dQw4w9WgXcQ', name: 'Ana', artist: 'Rick', title: 'Never', lyrics: { source: 'none' } },
  });
  await page.goto(room.guestUrl);
  await expect(page.getByText('Afinando o próximo show')).toBeVisible();
  await expect(page.getByRole('heading', { name: /Na fila/ })).toContainText('(1)');
  await expect(page.locator('.queue-item .chip')).toContainText(/Esperando a vez|Montando o palco|Aguardando|Chamando a banda|Isolando a banda|Procurando o refrão|Afinando/i);
});

test('the preview: plays the instrumental in a key, and the key holds for your song in the Queue', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: BIA, name: 'Bia' });
  await addToQueue(request, room.code, SONGS.bravo, { client: ANA, name: 'Ana' });
  await page.addInitScript((id) => localStorage.setItem('clientId', id), ANA);
  await page.goto(room.guestUrl);
  const mine = queueItem(page, 'Unethical');
  await mine.getByRole('button', { name: 'Prévia' }).click();
  const bar = page.getByRole('complementary', { name: 'Prévia da música' });
  await expect(bar).toBeVisible();
  await expect(bar).toContainText('Unethical');
  await expect(bar.getByText('Mudar o tom aqui muda o tom da sua música na fila.')).toBeVisible();
  await expect(bar.getByText('Tom original')).toBeVisible();
  await bar.getByRole('button', { name: 'Mais agudo' }).click();
  await expect(bar.locator('.pitch')).toHaveAttribute('data-pitch', '1');
  await expect.poll(async () => (await roomState(request, room.code)).queue.find((i) => i.video_id === SONGS.bravo.id)?.pitch).toBe(1);
  await expect(mine.locator('.pitch')).toHaveAttribute('data-pitch', '1');
  await bar.getByRole('button', { name: 'Fechar a prévia' }).click();
  await expect(bar).toBeHidden();
});

test("the preview of someone else's song does not change its key", async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: BIA, name: 'Bia' });
  await addToQueue(request, room.code, SONGS.bravo, { client: BIA, name: 'Bia' });
  await page.addInitScript((id) => localStorage.setItem('clientId', id), ANA);
  await page.goto(room.guestUrl);
  await queueItem(page, 'Unethical').getByRole('button', { name: 'Prévia' }).click();
  const bar = page.getByRole('complementary', { name: 'Prévia da música' });
  await expect(bar.getByText('Esta música é de outra pessoa')).toBeVisible();
  await bar.getByRole('button', { name: 'Mais grave' }).click();
  await expect(bar.locator('.pitch')).toHaveAttribute('data-pitch', '-1');
  expect((await roomState(request, room.code)).queue.find((i) => i.video_id === SONGS.bravo.id)?.pitch).toBe(0);
});

test("exporting MP4: asks for the video in the chosen key and downloads it with the song's name", async ({ page, request }) => {
  const room = await createRoom(request);
  const requests: string[] = [];
  await page.route('**/api/songs/*/export**', async (route) => {
    const req = route.request();
    requests.push(`${req.method()} ${new URL(req.url()).pathname}${new URL(req.url()).search} ${req.postData() ?? ''}`.trim());
    const body = req.method() === 'POST' ? { status: 'processing', error: null, url: null } : { status: 'ready', error: null, url: `/media/cache/${SONGS.bravo.id}/instrumental.mp3` };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto(room.guestUrl);
  await tab(page, 'Jukebox').click();
  const song = page.locator('.library li', { hasText: 'Unethical' }).first();
  await song.getByLabel('Tom do vídeo MP4').selectOption('2');
  const download = page.waitForEvent('download');
  await song.getByRole('button', { name: 'Baixar MP4' }).click();
  await expect(toast(page)).toContainText('Gerando o vídeo');
  expect((await download).suggestedFilename()).toBe('Faouzia - Unethical (+2).mp4');
  expect(requests[0]).toContain(`POST /api/songs/${SONGS.bravo.id}/export`);
  expect(requests[0]).toContain('"pitch":2');
  expect(requests[1]).toContain('GET');
  await expect(toast(page)).toContainText('Vídeo pronto');
});

test("the Room's links: copying the Room's and the Host's link; the token leaves the address bar", async ({ page, context, request }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const room = await createRoom(request);
  await page.goto(room.hostUrl);
  await expect(page).toHaveURL(room.guestUrl); // #host=... was kept and removed from the bar
  await page.getByRole('button', { name: 'Copiar link da sala' }).click();
  await expect(toast(page)).toContainText('Link da sala copiado!');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`http://127.0.0.1:3100/room.html?room=${room.code}`);
  await page.getByRole('button', { name: 'Copiar link de anfitrião' }).click();
  await expect(toast(page)).toContainText('Link de anfitrião copiado!');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`http://127.0.0.1:3100/room.html?room=${room.code}#host=${room.host}`);
});

test("the tabs switch the section, and the Host's change shows for everyone", async ({ page, request }) => {
  const room = await createRoom(request);
  await page.goto(room.guestUrl);
  await expect(page.getByRole('heading', { name: 'Tocando agora' })).toBeVisible();
  await tab(page, 'Adicionar').click();
  await expect(page.getByRole('heading', { name: 'Adicionar música' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Tocando agora' })).toBeHidden();
  await tab(page, 'Jukebox').click();
  await expect(page.getByRole('heading', { name: /Jukebox/ })).toBeVisible();
  await tab(page, 'Fila').click();
  await expect(page.getByRole('heading', { name: 'Tocando agora' })).toBeVisible();
  await hostPatch(request, room, { scoring: true });
  await expect(page.getByRole('heading', { name: 'Placar' })).toBeVisible(); // a change from another controller arrives over the WebSocket
});

test('adding a song: when the version is already ready in the Jukebox, the notice lets it be used at once', async ({ page, request }) => {
  const room = await createRoom(request);
  await page.goto(room.guestUrl);
  await tab(page, 'Adicionar').click();
  await page.getByLabel('Seu nome').fill('Carla');
  await page.getByLabel('Artista').fill('Adèle'); // with an accent, capitals and words out of order it still finds it
  await page.getByLabel('Nome da música').fill('rolling DEEP');
  await page.getByRole('button', { name: 'Buscar no YouTube' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading')).toHaveText('Encontramos esta versão pronta no nosso Jukebox, quer selecioná-la?');
  await expect(dialog.getByText('Rolling in the Deep', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Adele · 0:30')).toBeVisible();
  await expect(dialog.getByRole('radio')).toBeHidden(); // a single option: nothing to choose
  await dialog.getByRole('button', { name: 'Usar esta versão' }).click();

  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await roomState(request, room.code)).queue.length).toBe(1);
  const state = await roomState(request, room.code);
  expect(state.queue[0]).toMatchObject({ video_id: SONGS.charlie.id, added_by: 'Carla' });
  await expect(page.getByText('Carla está cantando')).toBeVisible(); // it went to the Queue's tab
  await tab(page, 'Adicionar').click();
  await expect(page.getByLabel('Artista')).toHaveValue(''); // the form goes back to the start
  await expect(page.getByText('Adicionada à fila (essa música já estava pronta).')).toBeVisible();
});

test('adding a song: with several ready versions, one of them is chosen', async ({ page, request }) => {
  const room = await createRoom(request);
  await page.goto(room.guestUrl);
  await tab(page, 'Adicionar').click();
  await page.getByLabel('Seu nome').fill('Carla'); // the name is required to add
  await page.getByLabel('Artista').fill('Faouzia');
  await page.getByLabel('Nome da música').fill('Unethical');
  await page.getByRole('button', { name: 'Buscar no YouTube' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading')).toHaveText('Encontramos estas versões prontas no nosso Jukebox, quer selecionar uma destas?');
  const options = dialog.getByRole('radio');
  await expect(options).toHaveCount(2);
  await expect(options.first()).toBeChecked(); // the first comes already chosen
  await dialog.getByText('Unethical (Acoustic)').click();
  await expect(options.nth(1)).toBeChecked();
  await dialog.getByRole('button', { name: 'Usar a versão selecionada' }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await roomState(request, room.code)).queue.map((i) => i.video_id)).toEqual([SONGS.delta.id]);
});

test('adding a song: "Buscar outra versão no YouTube" goes on with the search and does not ask again', async ({ page, request }) => {
  await request.post('/__test/search-results', {
    data: [{ video_id: 'otherVid001', title: 'Faouzia - Unethical (Live)', channel: 'Faouzia', duration: 210 }],
  });
  const room = await createRoom(request);
  await page.goto(room.guestUrl);
  await tab(page, 'Adicionar').click();
  await page.getByLabel('Artista').fill('Faouzia');
  await page.getByLabel('Nome da música').fill('Unethical');
  await page.getByRole('button', { name: 'Buscar no YouTube' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Buscar outra versão no YouTube' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.results .result')).toHaveCount(1);
  expect((await roomState(request, room.code)).queue).toHaveLength(0); // nothing went in the Queue
  // searching again with the same artist and name: the person already declined, it goes straight to YouTube
  await page.getByRole('button', { name: 'Buscar no YouTube' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.results .result')).toHaveCount(1);
  // changing the song's name, the notice holds again
  await page.getByLabel('Nome da música').fill('Unethical Acoustic');
  await page.getByRole('button', { name: 'Buscar no YouTube' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('adding a song: closing the notice with Esc does nothing', async ({ page, request }) => {
  const room = await createRoom(request);
  await page.goto(room.guestUrl);
  await tab(page, 'Adicionar').click();
  await page.getByLabel('Artista').fill('Adele');
  await page.getByLabel('Nome da música').fill('Rolling in the Deep');
  await page.getByRole('button', { name: 'Buscar no YouTube' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByLabel('Artista')).toHaveValue('Adele'); // the form stays as it was
  expect((await roomState(request, room.code)).queue).toHaveLength(0);
});

test("adding a song: Enter in the fields shows the Jukebox's notice too", async ({ page, request }) => {
  const room = await createRoom(request);
  await page.goto(room.guestUrl);
  await tab(page, 'Adicionar').click();
  await page.getByLabel('Artista').fill('Stone Sour');
  await page.getByLabel('Nome da música').fill('Wicked Game');
  await page.getByLabel('Nome da música').press('Enter');
  await expect(page.getByRole('dialog').getByText('Wicked Game', { exact: true })).toBeVisible();
});

test("adding a song: it finds the version by the YouTube video's original title too", async ({ page, request }) => {
  const room = await createRoom(request);
  await page.goto(room.guestUrl);
  await tab(page, 'Adicionar').click();
  await page.getByLabel('Seu nome').fill('Carla'); // the name is required to add
  // the song was kept as "Faouzia — Unethical (Acoustic)", but the video is called "Faouzia - Unethical (MAPHRA Vocal Cover)"
  await page.getByLabel('Artista').fill('Maphra');
  await page.getByLabel('Nome da música').fill('Unethical');
  await page.getByRole('button', { name: 'Buscar no YouTube' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading')).toHaveText('Encontramos esta versão pronta no nosso Jukebox, quer selecioná-la?');
  await expect(dialog.getByText('No YouTube: Faouzia - Unethical (MAPHRA Vocal Cover)')).toBeVisible();
  await dialog.getByRole('button', { name: 'Usar esta versão' }).click();
  await expect.poll(async () => (await roomState(request, room.code)).queue.map((i) => i.video_id)).toEqual([SONGS.delta.id]);
});

test("the Jukebox filters by the video's original title too", async ({ page, request }) => {
  const room = await createRoom(request);
  await page.goto(room.guestUrl);
  await tab(page, 'Jukebox').click();
  await page.getByLabel('Filtrar o Jukebox').fill('maphra');
  await expect(page.locator('.library li')).toHaveCount(1);
  await expect(page.locator('.library li')).toContainText('Unethical (Acoustic)');
});

test("the Jukebox is asked for along with the Room's code (so the songs on the owner's computer show)", async ({ page, request }) => {
  const room = await createRoom(request);
  const header = page.waitForRequest((req) => req.url().endsWith('/api/songs') && req.method() === 'GET');
  await page.goto(room.guestUrl);
  expect((await header).headers()['x-room']).toBe(room.code);
});

test.describe('whoever arrives without a name', () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test('a dialog asks for the name before anything, does not close without it, and the name goes to the Queue and the Room', async ({ page, request }) => {
    const room = await createRoom(request);
    await page.goto(room.guestUrl);
    const dialog = page.getByRole('dialog', { name: /Bem-vindo à sala/ });
    await expect(dialog).toBeVisible();
    const enter = dialog.getByRole('button', { name: 'Entrar na sala' });
    await expect(enter).toBeDisabled(); // without a name one does not enter
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible(); // Esc does not close it
    await dialog.getByLabel('Seu nome').fill('   ');
    await expect(enter).toBeDisabled(); // only spaces do not count either
    await dialog.getByLabel('Seu nome').fill('Dora');
    await enter.click();
    await expect(dialog).toBeHidden();
    await expect.poll(async () => (await roomState(request, room.code)).people.map((p) => p.name)).toContain('Dora');
    // the next visit already knows the name
    await page.reload();
    await expect(page.getByRole('dialog', { name: /Bem-vindo à sala/ })).toHaveCount(0);
    // and clearing the field to type another name does not bring the dialog back
    await page.getByRole('navigation', { name: 'Seções' }).getByRole('button', { name: 'Adicionar' }).click();
    await page.getByLabel('Seu nome').fill('');
    await expect(page.getByRole('dialog', { name: /Bem-vindo à sala/ })).toHaveCount(0);
  });
});
