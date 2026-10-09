// Painel "Adicionar música": busca livre (artista, nome da música ou os dois), aviso do Jukebox e confirmação da música.
import { expect, test } from '@playwright/test';
import { createRoom, roomState } from './helpers.mjs';

test.use({ viewport: { width: 390, height: 844 } });

const tab = (page, name) => page.getByRole('navigation', { name: 'Seções' }).getByRole('button', { name });
const artistField = (page) => page.getByLabel('Artista', { exact: true });
const titleField = (page) => page.getByLabel('Nome da música', { exact: true });
const searchButton = (page) => page.getByRole('button', { name: 'Buscar no YouTube' });
const searchResults = (request, results) => request.post('/__test/search-results', { data: results });
const lastSearch = async (request) => (await (await request.get('/__test/state')).json()).searchQueries.at(-1);

const BAD_GUY = [
  { video_id: 'badGuy00001', title: 'Billie Eilish - bad guy (Official Music Video)', channel: 'Billie Eilish', duration: 194 },
  { video_id: 'badGuy00002', title: 'bad guy (cover)', channel: 'Alguém', duration: 200 },
];

async function openAddTab(page, request) {
  const room = await createRoom(request);
  await page.goto(room.guestUrl);
  await tab(page, 'Adicionar').click();
  return room;
}

test('os campos de busca não trazem exemplos', async ({ page, request }) => {
  await openAddTab(page, request);
  await expect(artistField(page)).not.toHaveAttribute('placeholder', /.+/);
  await expect(titleField(page)).not.toHaveAttribute('placeholder', /.+/);
  await expect(page.locator('[placeholder*="ex.:"]')).toHaveCount(0);
});

test('basta o artista ou o nome da música para buscar, como no YouTube', async ({ page, request }) => {
  await searchResults(request, BAD_GUY);
  await openAddTab(page, request);

  await artistField(page).fill('Billie Eilish'); // só o artista
  await searchButton(page).click();
  await expect(page.locator('.results .result')).toHaveCount(2);
  expect(await lastSearch(request)).toBe('Billie Eilish');

  await artistField(page).fill('');
  await titleField(page).fill('Bad Guy'); // só o nome da música
  await searchButton(page).click();
  await expect.poll(() => lastSearch(request)).toBe('Bad Guy');

  await artistField(page).fill('Billie Eilish'); // os dois
  await searchButton(page).click();
  await expect.poll(() => lastSearch(request)).toBe('Billie Eilish - Bad Guy');

  // sem nenhum dos dois não busca
  await artistField(page).fill('');
  await titleField(page).fill('');
  await searchButton(page).click();
  await expect(page.getByText('Informe o artista ou o nome da música')).toBeVisible();
});

test('Enter com só um dos campos também busca', async ({ page, request }) => {
  await searchResults(request, BAD_GUY);
  await openAddTab(page, request);
  await titleField(page).fill('Bad Guy');
  await titleField(page).press('Enter');
  await expect(page.locator('.results .result')).toHaveCount(2);
});

test('a confirmação só aparece depois de escolher o vídeo e o que foi digitado vale mais que o palpite', async ({ page, request }) => {
  await searchResults(request, BAD_GUY);
  await openAddTab(page, request);
  await expect(page.getByLabel('Confirme o artista')).toHaveCount(0); // ainda não escolheu nada

  // só o nome digitado: o artista vem do título do vídeo ("Billie Eilish - bad guy (Official Music Video)")
  await titleField(page).fill('Bad Guy');
  await searchButton(page).click();
  await page.locator('.results .result').first().click();
  await expect(page.getByRole('heading', { name: 'Confirme a música' })).toBeVisible();
  await expect(page.getByLabel('Confirme o artista')).toHaveValue('Billie Eilish');
  await expect(page.getByLabel('Confirme o nome da música')).toHaveValue('Bad Guy');
});

test('com só o artista digitado, o nome da música vem do título do vídeo sem os enfeites', async ({ page, request }) => {
  await searchResults(request, BAD_GUY);
  await openAddTab(page, request);
  await artistField(page).fill('billie');
  await searchButton(page).click();
  await page.locator('.results .result').first().click();
  await expect(page.getByLabel('Confirme o artista')).toHaveValue('billie');
  await expect(page.getByLabel('Confirme o nome da música')).toHaveValue('bad guy'); // "(Official Music Video)" saiu
});

test('link colado sem nada digitado: a confirmação começa vazia para a pessoa preencher', async ({ page, request }) => {
  await openAddTab(page, request);
  await page.getByText('Já tenho o link do vídeo').click();
  await page.getByLabel('Link do vídeo do YouTube').fill('https://youtu.be/dQw4w9WgXcQ');
  await expect(page.getByLabel('Confirme o artista')).toHaveValue('');
  await expect(page.getByLabel('Confirme o nome da música')).toHaveValue('');
});

test('o artista e o nome confirmados é que vão para a fila, e os dois são obrigatórios', async ({ page, request }) => {
  await searchResults(request, BAD_GUY);
  const room = await openAddTab(page, request);
  await page.getByLabel('Seu nome').fill('Carla');
  await artistField(page).fill('billie');
  await searchButton(page).click();
  await page.locator('.results .result').first().click();
  await page.getByRole('combobox', { name: 'Letra' }).selectOption('none');

  // sem o nome da música confirmado não adiciona
  await page.getByLabel('Confirme o nome da música').fill('');
  await page.getByRole('button', { name: 'Adicionar à fila' }).click();
  await expect.poll(() => page.getByLabel('Confirme o nome da música').evaluate((el) => el.validity.valueMissing)).toBe(true);
  expect((await roomState(request, room.code)).queue).toHaveLength(0);

  // corrigindo os dois, vai para a fila com o que foi confirmado
  await page.getByLabel('Confirme o artista').fill('Billie Eilish');
  await page.getByLabel('Confirme o nome da música').fill('Bad Guy');
  await page.getByRole('button', { name: 'Adicionar à fila' }).click();
  await expect.poll(async () => (await roomState(request, room.code)).queue.length).toBe(1);
  const item = (await roomState(request, room.code)).queue[0];
  expect(item).toMatchObject({ video_id: 'badGuy00001', added_by: 'Carla', artist: 'Billie Eilish', title: 'Bad Guy' });
  // o formulário volta ao começo, sem a confirmação
  await tab(page, 'Adicionar').click();
  await expect(page.getByLabel('Confirme o artista')).toHaveCount(0);
});

test('o aviso do Jukebox também vale com só o artista ou só o nome', async ({ page, request }) => {
  await openAddTab(page, request);
  const dialog = page.getByRole('dialog');

  await artistField(page).fill('Adele'); // só o artista
  await searchButton(page).click();
  await expect(dialog.getByRole('heading')).toHaveText('Encontramos esta versão pronta no nosso Jukebox, quer selecioná-la?');
  await expect(dialog.getByText('Rolling in the Deep', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');

  await artistField(page).fill('');
  await titleField(page).fill('Wicked Game'); // só o nome da música
  await searchButton(page).click();
  await expect(dialog.getByText('Wicked Game', { exact: true })).toBeVisible();
});
