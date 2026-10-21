// The "Adicionar música" panel: a free search (the artist, the song's name or both), the Jukebox's notice and confirming the song.
import { type APIRequestContext, expect, type Page, test } from '@playwright/test';
import { createRoom, roomState } from './helpers.ts';

test.use({ viewport: { width: 390, height: 844 } });

type SearchResult = { video_id: string; title: string; channel: string; duration: number };

const tab = (page: Page, name: string) => page.getByRole('navigation', { name: 'Seções' }).getByRole('button', { name });
const artistField = (page: Page) => page.getByLabel('Artista', { exact: true });
const titleField = (page: Page) => page.getByLabel('Nome da música', { exact: true });
const searchButton = (page: Page) => page.getByRole('button', { name: 'Buscar no YouTube' });
const searchResults = (request: APIRequestContext, results: SearchResult[]) => request.post('/__test/search-results', { data: results });
const lastSearch = async (request: APIRequestContext): Promise<string | undefined> => (await (await request.get('/__test/state')).json()).searchQueries.at(-1);

const BAD_GUY = [
  { video_id: 'badGuy00001', title: 'Billie Eilish - bad guy (Official Music Video)', channel: 'Billie Eilish', duration: 194 },
  { video_id: 'badGuy00002', title: 'bad guy (cover)', channel: 'Someone', duration: 200 },
];

async function openAddTab(page: Page, request: APIRequestContext) {
  const room = await createRoom(request);
  await page.goto(room.guestUrl);
  await tab(page, 'Adicionar').click();
  return room;
}

test('the search fields bring no examples', async ({ page, request }) => {
  await openAddTab(page, request);
  await expect(artistField(page)).not.toHaveAttribute('placeholder', /.+/);
  await expect(titleField(page)).not.toHaveAttribute('placeholder', /.+/);
  await expect(page.locator('[placeholder*="ex.:"]')).toHaveCount(0);
});

test("the artist or the song's name is enough to search, as on YouTube", async ({ page, request }) => {
  await searchResults(request, BAD_GUY);
  await openAddTab(page, request);

  await artistField(page).fill('Billie Eilish'); // only the artist
  await searchButton(page).click();
  await expect(page.locator('.results .result')).toHaveCount(2);
  expect(await lastSearch(request)).toBe('Billie Eilish');

  await artistField(page).fill('');
  await titleField(page).fill('Bad Guy'); // only the song's name
  await searchButton(page).click();
  await expect.poll(() => lastSearch(request)).toBe('Bad Guy');

  await artistField(page).fill('Billie Eilish'); // both
  await searchButton(page).click();
  await expect.poll(() => lastSearch(request)).toBe('Billie Eilish - Bad Guy');

  // without either one it does not search
  await artistField(page).fill('');
  await titleField(page).fill('');
  await searchButton(page).click();
  await expect(page.getByText('Informe o artista ou o nome da música')).toBeVisible();
});

test('Enter with only one of the fields searches too', async ({ page, request }) => {
  await searchResults(request, BAD_GUY);
  await openAddTab(page, request);
  await titleField(page).fill('Bad Guy');
  await titleField(page).press('Enter');
  await expect(page.locator('.results .result')).toHaveCount(2);
});

test('the confirmation shows only after choosing the video, and what was typed beats the guess', async ({ page, request }) => {
  await searchResults(request, BAD_GUY);
  await openAddTab(page, request);
  await expect(page.getByLabel('Confirme o artista')).toHaveCount(0); // nothing chosen yet

  // only the name typed: the artist comes from the video's title ("Billie Eilish - bad guy (Official Music Video)")
  await titleField(page).fill('Bad Guy');
  await searchButton(page).click();
  await page.locator('.results .result').first().click();
  await expect(page.getByRole('heading', { name: 'Confirme a música' })).toBeVisible();
  await expect(page.getByLabel('Confirme o artista')).toHaveValue('Billie Eilish');
  await expect(page.getByLabel('Confirme o nome da música')).toHaveValue('Bad Guy');
});

test("with only the artist typed, the song's name comes from the video's title without the trimmings", async ({ page, request }) => {
  await searchResults(request, BAD_GUY);
  await openAddTab(page, request);
  await artistField(page).fill('billie');
  await searchButton(page).click();
  await page.locator('.results .result').first().click();
  await expect(page.getByLabel('Confirme o artista')).toHaveValue('billie');
  await expect(page.getByLabel('Confirme o nome da música')).toHaveValue('bad guy'); // "(Official Music Video)" went away
});

test('a pasted link with nothing typed: the confirmation starts empty for the person to fill in', async ({ page, request }) => {
  await openAddTab(page, request);
  await page.getByText('Já tenho o link do vídeo').click();
  await page.getByLabel('Link do vídeo do YouTube').fill('https://youtu.be/dQw4w9WgXcQ');
  await expect(page.getByLabel('Confirme o artista')).toHaveValue('');
  await expect(page.getByLabel('Confirme o nome da música')).toHaveValue('');
});

test('the confirmed artist and name are what goes to the Queue, and both are required', async ({ page, request }) => {
  await searchResults(request, BAD_GUY);
  const room = await openAddTab(page, request);
  await page.getByLabel('Seu nome').fill('Carla');
  await artistField(page).fill('billie');
  await searchButton(page).click();
  await page.locator('.results .result').first().click();
  await page.getByRole('combobox', { name: 'Letra' }).selectOption('none');

  // without the song's name confirmed it does not add
  await page.getByLabel('Confirme o nome da música').fill('');
  await page.getByRole('button', { name: 'Adicionar à fila' }).click();
  await expect.poll(() => page.getByLabel('Confirme o nome da música').evaluate((el) => (el as HTMLInputElement).validity.valueMissing)).toBe(true);
  expect((await roomState(request, room.code)).queue).toHaveLength(0);

  // fixing both, it goes to the Queue with what was confirmed
  await page.getByLabel('Confirme o artista').fill('Billie Eilish');
  await page.getByLabel('Confirme o nome da música').fill('Bad Guy');
  await page.getByRole('button', { name: 'Adicionar à fila' }).click();
  await expect.poll(async () => (await roomState(request, room.code)).queue.length).toBe(1);
  const item = (await roomState(request, room.code)).queue[0];
  expect(item).toMatchObject({ video_id: 'badGuy00001', added_by: 'Carla', artist: 'Billie Eilish', title: 'Bad Guy' });
  // the form goes back to the start, without the confirmation
  await tab(page, 'Adicionar').click();
  await expect(page.getByLabel('Confirme o artista')).toHaveCount(0);
});

test("the Jukebox's notice holds with only the artist or only the name too", async ({ page, request }) => {
  await openAddTab(page, request);
  const dialog = page.getByRole('dialog');

  await artistField(page).fill('Adele'); // only the artist
  await searchButton(page).click();
  await expect(dialog.getByRole('heading')).toHaveText('Encontramos esta versão pronta no nosso Jukebox, quer selecioná-la?');
  await expect(dialog.getByText('Rolling in the Deep', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');

  await artistField(page).fill('');
  await titleField(page).fill('Wicked Game'); // only the song's name
  await searchButton(page).click();
  await expect(dialog.getByText('Wicked Game', { exact: true })).toBeVisible();
});

test("without the person's name the song does not go in the Queue (and the field gets the focus)", async ({ page, request }) => {
  await searchResults(request, BAD_GUY);
  const room = await openAddTab(page, request);
  await page.getByLabel('Seu nome').fill(''); // the person deleted the name the dialog asked for on arrival
  await artistField(page).fill('billie');
  await searchButton(page).click(); // searching is still free
  await page.locator('.results .result').first().click();
  await page.getByRole('combobox', { name: 'Letra' }).selectOption('none');
  await page.getByLabel('Confirme o artista').fill('Billie Eilish');
  await page.getByLabel('Confirme o nome da música').fill('Bad Guy');

  await page.getByRole('button', { name: 'Adicionar à fila' }).click();
  await expect(page.getByText('Digite o seu nome antes de adicionar uma música.')).toBeVisible();
  await expect(page.getByLabel('Seu nome')).toBeFocused();
  expect((await roomState(request, room.code)).queue).toHaveLength(0);

  await page.getByLabel('Seu nome').fill('   '); // only spaces do not count either
  await page.getByRole('button', { name: 'Adicionar à fila' }).click();
  expect((await roomState(request, room.code)).queue).toHaveLength(0);

  await page.getByLabel('Seu nome').fill('Carla');
  await page.getByRole('button', { name: 'Adicionar à fila' }).click();
  await expect.poll(async () => (await roomState(request, room.code)).queue.length).toBe(1);
});
