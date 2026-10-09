import { expect, test } from '@playwright/test';
import { addToQueue, ANA, BIA, createRoom, hostPatch, roomState, SONGS } from './helpers.mjs';

test.use({ viewport: { width: 390, height: 844 } });

const queueItem = (page, title) => page.locator('.queue-item', { hasText: title });
const tab = (page, name) => page.getByRole('navigation', { name: 'Seções' }).getByRole('button', { name });
const toast = (page) => page.locator('.toast');

test('sala sem código volta para a entrada; sala que não existe mostra o aviso', async ({ page }) => {
  await page.goto('/room.html');
  await expect(page).toHaveURL(/\/$/);
  await page.goto('/room.html?room=ZZZZ');
  await expect(page.getByRole('heading', { name: 'Sala não encontrada' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Criar uma nova sala' })).toBeVisible();
});

test('mostra o código, o estado da TV e a fila vazia', async ({ page, request }) => {
  const room = await createRoom(request);
  await page.goto(room.guestUrl);
  await expect(page).toHaveTitle(`Singalong — Sala ${room.code}`);
  await expect(page.getByRole('heading', { name: `Sala ${room.code}` })).toBeVisible();
  await expect(page.getByText('TV desconectada')).toBeVisible();
  await expect(page.getByText('Nada tocando.')).toBeVisible();
  await expect(page.getByText('Ninguém na fila.')).toBeVisible();
});

test('a TV abrindo muda o estado para "TV conectada"', async ({ page, context, request }) => {
  const room = await createRoom(request);
  await page.goto(room.guestUrl);
  await expect(page.getByText('TV desconectada')).toBeVisible();
  const tv = await context.newPage();
  await tv.goto(room.tvUrl);
  await expect(page.getByText('TV conectada', { exact: true })).toBeVisible();
  await tv.close();
  await expect(page.getByText('TV desconectada')).toBeVisible();
});

test('a biblioteca lista as músicas prontas, filtra por artista e nome e adiciona na fila', async ({ page, request }) => {
  const room = await createRoom(request);
  await page.goto(room.guestUrl);
  await tab(page, 'Músicas').click();
  const library = page.locator('.library li');
  await expect(library).toHaveCount(4);
  await expect(page.getByRole('heading', { name: /Músicas já processadas/ })).toContainText('(4)');

  const filter = page.getByLabel('Filtrar as músicas já processadas');
  await filter.fill('faouzia');
  await expect(library).toHaveCount(2);
  await expect(library.first()).toContainText('Unethical');
  await expect(page.getByRole('heading', { name: /Músicas já processadas/ })).toContainText('(2 de 4)');

  await filter.fill('nada disso existe');
  await expect(page.getByText('Nenhuma música encontrada para “nada disso existe”.')).toBeVisible();
  await page.getByRole('button', { name: 'Limpar filtro' }).click();
  await expect(library).toHaveCount(4);

  await page.getByLabel('Seu nome').isHidden(); // o campo de nome fica na aba "Adicionar"
  await library.filter({ hasText: 'Rolling in the Deep' }).getByRole('button', { name: 'Adicionar' }).click();
  await expect(toast(page)).toContainText('Adicionada à fila!');
  await tab(page, 'Fila').click();
  await expect(page.getByRole('heading', { name: 'Tocando agora' })).toBeVisible();
  await expect(page.locator('.now-content').first()).toContainText('Rolling in the Deep');
  expect((await roomState(request, room.code)).queue.map((i) => i.video_id)).toEqual([SONGS.charlie.id]);
});

test('o que toca agora e a fila: quem canta, próximo e contagem', async ({ page, request }) => {
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

test('anfitrião: pausar, retomar, avançar, voltar e pular', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' });
  await addToQueue(request, room.code, SONGS.bravo, { client: BIA, name: 'Bia' });
  await page.goto(room.hostUrl);
  await page.getByRole('button', { name: 'Pausar' }).click();
  await expect(page.getByRole('button', { name: 'Retomar' })).toBeVisible();
  expect((await roomState(request, room.code, { host: room.host })).playback).toBe('paused');
  await page.getByRole('button', { name: 'Retomar' }).click();
  await expect(page.getByRole('button', { name: 'Pausar' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Voltar 10 segundos' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Avançar 10 segundos' })).toBeVisible();
  await page.getByRole('button', { name: 'Avançar 10 segundos' }).click(); // sem TV conectada: só não pode dar erro
  await expect(toast(page)).not.toHaveClass(/error/);
  await page.getByRole('button', { name: 'Pular' }).click();
  await expect(page.getByText('Bia está cantando')).toBeVisible();
  await expect(page.getByText('Ninguém na fila.')).toBeVisible();
});

test('anfitrião: ajuste da letra, tom, mover e remover na fila', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' });
  await addToQueue(request, room.code, SONGS.bravo, { client: BIA, name: 'Bia' });
  await addToQueue(request, room.code, SONGS.charlie, { client: BIA, name: 'Bia' });
  await page.goto(room.hostUrl);

  await expect(page.getByText('Ajuste da letra')).toBeVisible();
  await page.getByRole('button', { name: '+0.5 s' }).click();
  await expect(page.getByText('0,5 s', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '−0.1 s' }).click();
  await expect(page.getByText('0,4 s', { exact: true })).toBeVisible();

  // tom da música que está tocando
  await page.locator('.now .pitch').getByRole('button', { name: 'Tom mais agudo' }).click();
  await expect(page.locator('.now .pitch-value')).toHaveText('Tom +1');

  // ordem: Unethical, Rolling in the Deep; subir a segunda
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

test('rodízio justo e pontuação: só o anfitrião vê e liga; a fila mostra a ordem do rodízio', async ({ page, browser, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' });
  await addToQueue(request, room.code, SONGS.bravo, { name: 'Ana' });
  await addToQueue(request, room.code, SONGS.charlie, { client: BIA, name: 'Bia' });
  await page.goto(room.hostUrl);
  await page.getByLabel('Opções da sala').click();
  await page.getByLabel(/Rodízio justo/).check();
  await expect(page.getByLabel(/Rodízio justo/)).toBeChecked();
  expect((await roomState(request, room.code)).fair).toBe(true);
  // com o rodízio, a Bia canta antes da 2ª música da Ana, e subir/descer ficam desabilitados
  const items = page.locator('.queue-item');
  await expect(items.nth(0)).toContainText('Rolling in the Deep');
  await expect(items.nth(1)).toContainText('Unethical');
  await expect(items.nth(0).getByRole('button', { name: 'Descer na fila' })).toBeDisabled();

  await page.getByLabel(/Pontuação pelo microfone/).check();
  await expect.poll(async () => (await roomState(request, room.code)).scoring).toBe(true);
  await expect(page.getByRole('heading', { name: 'Placar' })).toBeVisible();

  const guest = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage(); // outro navegador: sem o token
  await guest.goto(room.guestUrl);
  await guest.getByLabel('Opções da sala').click();
  await expect(guest.getByLabel(/Rodízio justo/)).toBeHidden();
  await expect(guest.getByRole('button', { name: 'Copiar link de anfitrião' })).toBeHidden();
});

test('quem não é anfitrião só mexe nas próprias músicas e pode ceder a vez', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: BIA, name: 'Bia' });
  await addToQueue(request, room.code, SONGS.bravo, { client: ANA, name: 'Ana' });
  await addToQueue(request, room.code, SONGS.charlie, { client: BIA, name: 'Bia' });
  // o navegador do teste é a Ana (o mesmo client id que adicionou "Unethical")
  await page.addInitScript((id) => localStorage.setItem('clientId', id), ANA);
  await page.goto(room.guestUrl);
  await expect(page.getByRole('button', { name: 'Pausar' })).toBeHidden();
  await expect(page.getByText('Ajuste da letra')).toBeHidden();
  const mine = queueItem(page, 'Unethical');
  const others = queueItem(page, 'Rolling in the Deep');
  await expect(mine.getByRole('button', { name: 'Remover da fila' })).toBeVisible();
  await expect(others.getByRole('button', { name: 'Remover da fila' })).toBeHidden();
  await expect(others.getByRole('button', { name: 'Tom mais agudo' })).toBeHidden();
  await mine.getByRole('button', { name: 'Ceder a vez' }).click();
  await expect(toast(page)).toContainText('Você cedeu a vez');
  await expect(page.locator('.queue-item').nth(0)).toContainText('Rolling in the Deep');
  await expect(page.locator('.queue-item').nth(1)).toContainText('Unethical');
});

test('adicionar música: buscar no YouTube, escolher o vídeo e colocar na fila', async ({ page, request }) => {
  await request.post('/__test/search-results', {
    data: [
      { video_id: 'newVideo001', title: 'Billie Eilish - bad guy (Official)', channel: 'Billie Eilish', duration: 190 },
      { video_id: 'newVideo002', title: 'bad guy (cover)', channel: 'Alguém', duration: 200 },
    ],
  });
  const room = await createRoom(request);
  await page.goto(room.guestUrl);
  await tab(page, 'Adicionar').click();

  await page.getByLabel('Seu nome').fill('Carla');
  // sem artista e nome não busca
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

test('adicionar música: link colado, letra para colar e erros', async ({ page, request }) => {
  const room = await createRoom(request);
  await page.goto(room.guestUrl);
  await tab(page, 'Adicionar').click();
  await page.getByText('Já tenho o link do vídeo').click();
  await page.getByLabel('Link do vídeo do YouTube').fill('https://youtu.be/dQw4w9WgXcQ?si=x');
  await expect(page.getByText('Link reconhecido: dQw4w9WgXcQ')).toBeVisible();
  await page.getByLabel('Link do vídeo do YouTube').fill('lixo');
  await expect(page.getByText('Link reconhecido')).toBeHidden();

  const source = page.getByRole('combobox', { name: 'Letra' });
  await expect(page.getByLabel('Letra', { exact: true }).and(page.locator('textarea'))).toBeHidden();
  await source.selectOption('align');
  await expect(page.locator('textarea[aria-label="Letra"]')).toBeVisible();
  await source.selectOption('lrclib');
  await expect(page.locator('textarea[aria-label="Letra"]')).toBeHidden();

  // música que o servidor recusa mostra a mensagem no próprio formulário
  await page.getByLabel('Artista').fill('A');
  await page.getByLabel('Nome da música').fill('B');
  await page.getByLabel('Link do vídeo do YouTube').fill('https://youtu.be/dQw4w9WgXcQ');
  await source.selectOption('align');
  await page.locator('textarea[aria-label="Letra"]').fill('uma linha');
  await page.getByRole('button', { name: 'Adicionar à fila' }).click();
  await tab(page, 'Fila').click();
  await expect.poll(async () => (await roomState(request, room.code)).queue.length).toBe(1);
  expect((await request.get('/__test/state').then((r) => r.json())).queue.at(-1).payload).toMatchObject({ lyrics_source: 'align', lyrics_text: 'uma linha' });
});

test('música ainda preparando e música que pede letra aparecem com o aviso certo', async ({ page, request }) => {
  const room = await createRoom(request);
  await request.post(`/api/rooms/${room.code}/queue`, {
    headers: { 'x-client-id': ANA },
    data: { url: 'https://youtu.be/dQw4w9WgXcQ', name: 'Ana', artist: 'Rick', title: 'Never', lyrics: { source: 'none' } },
  });
  await page.goto(room.guestUrl);
  await expect(page.getByText('Preparando a próxima música')).toBeVisible();
  await expect(page.getByRole('heading', { name: /Na fila/ })).toContainText('(1)');
  await expect(page.locator('.queue-item .chip')).toContainText(/Na fila|Preparando|Aguardando|Baixando/i);
});

test('prévia: toca o instrumental com tom e o tom vale para a sua música na fila', async ({ page, request }) => {
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
  await expect(bar.getByText('Tom 0')).toBeVisible();
  await bar.getByRole('button', { name: 'Tom mais agudo' }).click();
  await expect(bar.getByText('Tom +1')).toBeVisible();
  await expect.poll(async () => (await roomState(request, room.code)).queue.find((i) => i.video_id === SONGS.bravo.id).pitch).toBe(1);
  await expect(mine.locator('.pitch-value')).toHaveText('Tom +1');
  await bar.getByRole('button', { name: 'Fechar a prévia' }).click();
  await expect(bar).toBeHidden();
});

test('prévia de música de outra pessoa não muda o tom dela', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: BIA, name: 'Bia' });
  await addToQueue(request, room.code, SONGS.bravo, { client: BIA, name: 'Bia' });
  await page.addInitScript((id) => localStorage.setItem('clientId', id), ANA);
  await page.goto(room.guestUrl);
  await queueItem(page, 'Unethical').getByRole('button', { name: 'Prévia' }).click();
  const bar = page.getByRole('complementary', { name: 'Prévia da música' });
  await expect(bar.getByText('Esta música é de outra pessoa')).toBeVisible();
  await bar.getByRole('button', { name: 'Tom mais grave' }).click();
  await expect(bar.getByText('Tom -1').or(bar.getByText('Tom −1'))).toBeVisible();
  expect((await roomState(request, room.code)).queue.find((i) => i.video_id === SONGS.bravo.id).pitch).toBe(0);
});

test('exportar MP4: pede o vídeo no tom escolhido e baixa com o nome da música', async ({ page, request }) => {
  const room = await createRoom(request);
  const requests = [];
  await page.route('**/api/songs/*/export**', async (route) => {
    const req = route.request();
    requests.push(`${req.method()} ${new URL(req.url()).pathname}${new URL(req.url()).search} ${req.postData() ?? ''}`.trim());
    const body = req.method() === 'POST' ? { status: 'processing', error: null, url: null } : { status: 'ready', error: null, url: `/media/cache/${SONGS.bravo.id}/instrumental.mp3` };
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.goto(room.guestUrl);
  await tab(page, 'Músicas').click();
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

test('os links da sala: copiar link da sala e de anfitrião; o token sai da barra de endereço', async ({ page, context, request }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const room = await createRoom(request);
  await page.goto(room.hostUrl);
  await expect(page).toHaveURL(room.guestUrl); // #host=... foi guardado e removido da barra
  await page.getByLabel('Opções da sala').click();
  await page.getByRole('button', { name: 'Copiar link da sala' }).click();
  await expect(toast(page)).toContainText('Link da sala copiado!');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`http://127.0.0.1:3100/room.html?room=${room.code}`);
  await page.getByLabel('Opções da sala').click();
  await page.getByRole('button', { name: 'Copiar link de anfitrião' }).click();
  await expect(toast(page)).toContainText('Link de anfitrião copiado!');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`http://127.0.0.1:3100/room.html?room=${room.code}#host=${room.host}`);
});

test('as abas trocam a seção e a mudança de rodízio do anfitrião aparece para todos', async ({ page, request }) => {
  const room = await createRoom(request);
  await page.goto(room.guestUrl);
  await expect(page.getByRole('heading', { name: 'Tocando agora' })).toBeVisible();
  await tab(page, 'Adicionar').click();
  await expect(page.getByRole('heading', { name: 'Adicionar música' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Tocando agora' })).toBeHidden();
  await tab(page, 'Músicas').click();
  await expect(page.getByRole('heading', { name: /Músicas já processadas/ })).toBeVisible();
  await tab(page, 'Fila').click();
  await expect(page.getByRole('heading', { name: 'Tocando agora' })).toBeVisible();
  await hostPatch(request, room, { scoring: true });
  await expect(page.getByRole('heading', { name: 'Placar' })).toBeVisible(); // mudança de outro controle chega por WebSocket
});

test('adicionar música: se a versão já está pronta no Jukebox, o aviso deixa usá-la na hora', async ({ page, request }) => {
  const room = await createRoom(request);
  await page.goto(room.guestUrl);
  await tab(page, 'Adicionar').click();
  await page.getByLabel('Seu nome').fill('Carla');
  await page.getByLabel('Artista').fill('Adèle'); // com acento, maiúsculas e palavras fora de ordem também acha
  await page.getByLabel('Nome da música').fill('rolling DEEP');
  await page.getByRole('button', { name: 'Buscar no YouTube' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading')).toHaveText('Encontramos esta versão pronta no nosso Jukebox, quer selecioná-la?');
  await expect(dialog.getByText('Rolling in the Deep', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Adele · 0:30')).toBeVisible();
  await expect(dialog.getByRole('radio')).toBeHidden(); // uma só opção: não há o que escolher
  await dialog.getByRole('button', { name: 'Usar esta versão' }).click();

  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await roomState(request, room.code)).queue.length).toBe(1);
  const state = await roomState(request, room.code);
  expect(state.queue[0]).toMatchObject({ video_id: SONGS.charlie.id, added_by: 'Carla' });
  await expect(page.getByText('Carla está cantando')).toBeVisible(); // foi para a aba da fila
  await tab(page, 'Adicionar').click();
  await expect(page.getByLabel('Artista')).toHaveValue(''); // o formulário volta ao começo
  await expect(page.getByText('Adicionada à fila (essa música já estava pronta).')).toBeVisible();
});

test('adicionar música: com várias versões prontas, escolhe uma delas', async ({ page, request }) => {
  const room = await createRoom(request);
  await page.goto(room.guestUrl);
  await tab(page, 'Adicionar').click();
  await page.getByLabel('Artista').fill('Faouzia');
  await page.getByLabel('Nome da música').fill('Unethical');
  await page.getByRole('button', { name: 'Buscar no YouTube' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading')).toHaveText('Encontramos estas versões prontas no nosso Jukebox, quer selecionar uma destas?');
  const options = dialog.getByRole('radio');
  await expect(options).toHaveCount(2);
  await expect(options.first()).toBeChecked(); // a primeira já vem escolhida
  await dialog.getByText('Unethical (Acoustic)').click();
  await expect(options.nth(1)).toBeChecked();
  await dialog.getByRole('button', { name: 'Usar a versão selecionada' }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await roomState(request, room.code)).queue.map((i) => i.video_id)).toEqual([SONGS.delta.id]);
});

test('adicionar música: "Buscar outra versão no YouTube" segue a busca e não pergunta de novo', async ({ page, request }) => {
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
  expect((await roomState(request, room.code)).queue).toHaveLength(0); // nada entrou na fila
  // buscar de novo com o mesmo artista e nome: a pessoa já recusou, vai direto ao YouTube
  await page.getByRole('button', { name: 'Buscar no YouTube' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.results .result')).toHaveCount(1);
  // mudando o nome da música o aviso volta a valer
  await page.getByLabel('Nome da música').fill('Unethical Acoustic');
  await page.getByRole('button', { name: 'Buscar no YouTube' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});

test('adicionar música: fechar o aviso com Esc não faz nada', async ({ page, request }) => {
  const room = await createRoom(request);
  await page.goto(room.guestUrl);
  await tab(page, 'Adicionar').click();
  await page.getByLabel('Artista').fill('Adele');
  await page.getByLabel('Nome da música').fill('Rolling in the Deep');
  await page.getByRole('button', { name: 'Buscar no YouTube' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByLabel('Artista')).toHaveValue('Adele'); // o formulário continua como estava
  expect((await roomState(request, room.code)).queue).toHaveLength(0);
});

test('adicionar música: Enter nos campos também mostra o aviso do Jukebox', async ({ page, request }) => {
  const room = await createRoom(request);
  await page.goto(room.guestUrl);
  await tab(page, 'Adicionar').click();
  await page.getByLabel('Artista').fill('Stone Sour');
  await page.getByLabel('Nome da música').fill('Wicked Game');
  await page.getByLabel('Nome da música').press('Enter');
  await expect(page.getByRole('dialog').getByText('Wicked Game', { exact: true })).toBeVisible();
});

test('adicionar música: acha a versão também pelo título original do vídeo no YouTube', async ({ page, request }) => {
  const room = await createRoom(request);
  await page.goto(room.guestUrl);
  await tab(page, 'Adicionar').click();
  // a música foi guardada como "Faouzia — Unethical (Acoustic)", mas o vídeo se chama "Faouzia - Unethical (MAPHRA Vocal Cover)"
  await page.getByLabel('Artista').fill('Maphra');
  await page.getByLabel('Nome da música').fill('Unethical');
  await page.getByRole('button', { name: 'Buscar no YouTube' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading')).toHaveText('Encontramos esta versão pronta no nosso Jukebox, quer selecioná-la?');
  await expect(dialog.getByText('No YouTube: Faouzia - Unethical (MAPHRA Vocal Cover)')).toBeVisible();
  await dialog.getByRole('button', { name: 'Usar esta versão' }).click();
  await expect.poll(async () => (await roomState(request, room.code)).queue.map((i) => i.video_id)).toEqual([SONGS.delta.id]);
});

test('a biblioteca também filtra pelo título original do vídeo', async ({ page, request }) => {
  const room = await createRoom(request);
  await page.goto(room.guestUrl);
  await tab(page, 'Músicas').click();
  await page.getByLabel('Filtrar as músicas já processadas').fill('maphra');
  await expect(page.locator('.library li')).toHaveCount(1);
  await expect(page.locator('.library li')).toContainText('Unethical (Acoustic)');
});
