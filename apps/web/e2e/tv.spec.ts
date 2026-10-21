import { type APIRequestContext, expect, type Locator, type Page, test } from '@playwright/test';
import { addToQueue, ANA, BIA, createRoom, hostPatch, roomState, SONGS, type TestRoom } from './helpers.ts';

const hostPost = (request: APIRequestContext, room: TestRoom, path: string, data?: Record<string, unknown>) =>
  request.post(`/api/rooms/${room.code}${path}`, { headers: { 'x-client-id': ANA, 'x-host-token': room.host }, data });
/** Clipped creatures: for each one, the elements above it that clip their overflow must hold the whole drawing. */
const clippedBlobs = (page: Page) =>
  page.evaluate(() => {
    const out: string[] = [];
    for (const blob of document.querySelectorAll('.singer-blobs .blob')) {
      // the breathing creature (an inline SVG) goes past its own frame: the SVG must not clip its overflow
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
// really playing: the audio has loaded (its duration is known) and the clock moved; `playing` alone holds as soon as play() is called
const playing = (page: Page) => page.evaluate(() => window.tv.engine.playing && window.tv.engine.duration > 0 && window.tv.engine.currentTime > 0);
/** The element's box (the test expects it to be on screen). */
const boxOf = async (locator: Locator) => {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box!;
};

test('without a Room in the URL the TV says so', async ({ page }) => {
  await page.goto('/tv.html');
  await expect(page.getByRole('status')).toContainText('Abra a TV a partir de uma sala');
});

test('a Room that does not exist: a notice on the TV', async ({ page }) => {
  await page.goto('/tv.html?room=ZZZZ');
  await expect(page.getByRole('status')).toContainText('Sala não encontrada');
});

test("no song: the waiting screen with the code, the QR code and the Room's link", async ({ page, request }) => {
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

test('on the waiting screen it shows the next song while it is still being prepared', async ({ page, request }) => {
  const room = await createRoom(request);
  await request.post(`/api/rooms/${room.code}/queue`, {
    headers: { 'x-client-id': ANA },
    data: { url: 'https://youtu.be/dQw4w9WgXcQ', name: 'Ana', artist: 'Rick', title: 'Never', lyrics: { source: 'none' } },
  });
  await page.goto(room.tvUrl);
  await expect(page.getByText(/Próximo: Ana — Never \(preparando…\)/)).toBeVisible();
});

test('it plays: shows who sings, the key, the Queue, the synced lyrics and the progress bar', async ({ page, request }) => {
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
  await expect(page.locator('.idle')).toBeHidden(); // the waiting screen goes away

  await expect.poll(() => playing(page)).toBe(true);
  // the lyrics follow the clock: the 1st line comes in at ~1 s and the 2nd at ~5 s
  await expect(page.locator('.line.current')).toContainText('Primeira linha da letra');
  await expect(page.locator('.line.next')).toContainText('Segunda linha cantada agora');
  // words filled with each one's time (--p goes from 0 to 100%)
  await expect.poll(() => page.locator('.line.current .w').evaluateAll((els) => els.filter((e) => parseFloat((e as HTMLElement).style.getPropertyValue('--p')) > 0).length)).toBeGreaterThan(0);
  await expect.poll(() => page.locator('.tv-progress > div').evaluate((el) => parseFloat((el as HTMLElement).style.width))).toBeGreaterThan(0);
  // the connected TV shows for the phones
  await expect.poll(async () => (await roomState(request, room.code)).tv_connected).toBe(true);
});

test("pausing and resuming by the Host stop and bring back the TV's sound", async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' });
  await page.goto(room.tvUrl);
  await expect.poll(() => playing(page)).toBe(true);
  await hostPost(request, room, '/player/pause');
  await expect.poll(() => playing(page)).toBe(false);
  await hostPost(request, room, '/player/resume');
  await expect.poll(() => playing(page)).toBe(true);
});

test("the chosen key reaches the audio engine, and so does the lyrics' offset", async ({ page, request }) => {
  const room = await createRoom(request);
  const itemId = await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana', pitch: 2 });
  await page.goto(room.tvUrl);
  await expect.poll(() => page.evaluate(() => window.tv.engine.pitch)).toBe(2);
  await request.patch(`/api/rooms/${room.code}/queue/${itemId}`, { headers: { 'x-client-id': ANA }, data: { pitch: -3 } });
  await expect.poll(() => page.evaluate(() => window.tv.engine.pitch)).toBe(-3);
  await request.put(`/api/rooms/${room.code}/songs/${SONGS.alpha.id}/offset`, { headers: { 'x-client-id': ANA, 'x-host-token': room.host }, data: { offset: 1.5 } });
  await expect.poll(() => page.evaluate(() => window.tv.engine.offset)).toBe(1.5);
});

test('going back and forward 10 s: the TV makes the jump', async ({ page, request }) => {
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

test('skipping moves to the next one; a song that ends moves on by itself too', async ({ page, request }) => {
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
  // near the end: the audio ends, the TV says so and the Room moves to the next one
  await hostPost(request, room, '/player/seek', { seconds: 28 });
  await expect(page.locator('.singer.is-now')).toContainText('Rolling in the Deep', { timeout: 15_000 });
  expect((await roomState(request, room.code)).queue.map((i) => i.video_id)).toEqual([SONGS.charlie.id]);
});

test('an empty Queue after the last song: back to the waiting screen', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' });
  await page.goto(room.tvUrl);
  await expect(page.locator('.singer.is-now')).toBeVisible();
  await hostPost(request, room, '/player/skip');
  await expect(page.getByText(`Entre na sala ${room.code} pelo celular`)).toBeVisible();
  await expect(page.locator('.singer.is-now')).toBeHidden();
});

test('a TV reloaded mid-song resumes where it was', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' });
  await page.goto(room.tvUrl);
  await expect.poll(() => playing(page)).toBe(true);
  await hostPost(request, room, '/player/seek', { seconds: 12 });
  await expect.poll(async () => (await roomState(request, room.code)).position_ms, { timeout: 10_000 }).toBeGreaterThan(10_000);
  await page.reload();
  await expect.poll(() => page.evaluate(() => window.tv.engine.currentTime), { timeout: 10_000 }).toBeGreaterThan(10);
});

test('scoring: the card shows the original and the sung note, and the final score goes to the scoreboard', async ({ page, request }) => {
  test.setTimeout(60_000);
  const room = await createRoom(request);
  await hostPatch(request, room, { scoring: true });
  await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' });
  await page.goto(room.tvUrl);
  await expect(page.locator('.score-hud')).toBeVisible();
  await expect(page.locator('.score-hud')).toContainText('Pontuação');
  await expect(page.locator('.score-hud small')).toContainText(/Original: [A-G]#?\d/);
  await expect(page.locator('.score-hud small')).toContainText('Você:');
  await expect(page.locator('.score-hud small strong').first()).toBeVisible(); // the notes in bold

  // 10 s at the song's end: plenty of time for the score to count (a minimum of 5 s with a voice in the original)
  await hostPost(request, room, '/player/seek', { seconds: 20 });
  await expect(page.locator('.score-final')).toBeVisible({ timeout: 25_000 });
  await expect(page.locator('.score-final')).toContainText('Pontuação final');
  await expect(page.locator('.score-final strong')).toHaveText(/^\d+$/);
  await expect(page.locator('.score-final')).toContainText('Ana');
  await expect.poll(async () => (await roomState(request, room.code)).scoreboard.length).toBe(1);
});

test('without scoring on, the card does not show', async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' });
  await page.goto(room.tvUrl);
  await expect(page.locator('.singer.is-now')).toBeVisible();
  await expect(page.locator('.score-hud')).toBeHidden();
});

test("the Room's QR code stays on the TV while the song plays (beside who is singing)", async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: ANA, name: 'Ana' });
  await page.goto(room.tvUrl);
  await expect.poll(() => page.evaluate(() => window.tv.engine.playing)).toBe(true);
  const card = page.getByRole('complementary', { name: 'Entrar na sala' });
  await expect(card).toBeVisible();
  await expect(card.getByLabel('QR code para entrar na sala').locator('svg')).toBeVisible();
  await expect(page.locator('.room-tag')).toContainText(room.code); // the written code stays in the header
  await expect(page.locator('.singer.is-now')).toBeVisible();
});

test("scoring and the melody guide are marked beta (the switches, the guide and the TV's card)", async ({ page, request }) => {
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

test('the waiting room: "Aguardando cantores" with the QR code in the center, and the phones that join show up in real time', async ({ browser, page, request }) => {
  const room = await createRoom(request);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(room.tvUrl);
  await expect(page.getByRole('heading', { name: 'Aguardando cantores…' })).toBeVisible();
  await expect(page.getByText('Ninguém conectado ainda')).toBeVisible();
  await expect(page.locator('.slot.free')).toHaveCount(4); // free spots while nobody joins

  // the QR code sits in the center of the glass panel, and the panel in the center of the screen
  const qr = await boxOf(page.locator('.lobby-qr'));
  const lobby = await boxOf(page.locator('.lobby'));
  expect(Math.abs(qr.x + qr.width / 2 - (lobby.x + lobby.width / 2))).toBeLessThanOrEqual(2);
  expect(Math.abs(lobby.x + lobby.width / 2 - 1280 / 2)).toBeLessThanOrEqual(2);

  // a phone joins by the code: the avatar with the name shows on the TV without reloading
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(() => {
    localStorage.setItem('clientId', 'client-lobby-0001');
    localStorage.setItem('userName', 'Marina');
  });
  const phone = await context.newPage();
  await phone.goto(room.guestUrl);
  await expect(page.locator('.slot.filled')).toContainText('Marina');
  await expect(page.locator('.slot.filled svg.blob')).toBeVisible(); // the creature (blobatar) made from the name
  await expect(page.getByText('1 cantor conectado')).toBeVisible();

  // and it leaves when the phone closes
  await context.close();
  await expect(page.locator('.slot.filled')).toHaveCount(0);
  await expect(page.getByText('Ninguém conectado ainda')).toBeVisible();
});

test('the waiting room: there is no limit of singers; past 7, the last spot shows how many more there are', async ({ page, request }) => {
  const room = await createRoom(request);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(room.tvUrl);
  // ten phones connected (the same Room WebSocket the phone opens)
  await page.evaluate((code) => {
    window.phones = Array.from({ length: 10 }, (_, i) =>
      new WebSocket(`ws://${location.host}/api/rooms/ws?code=${code}&role=controller&client=lobby-phone-${i}&name=Pessoa${i}`));
  }, room.code);
  await expect(page.getByText('10 cantores conectados')).toBeVisible();
  await expect(page.locator('.slot.filled')).toHaveCount(6);
  await expect(page.locator('.slot.more')).toContainText('+4');
  await expect(page.locator('.slot.free')).toHaveCount(0);
  // the row fits the poster and the poster fits the screen
  const sheet = await boxOf(page.locator('.lobby-sheet'));
  const slots = await boxOf(page.locator('.lobby-slots'));
  expect(slots.x).toBeGreaterThanOrEqual(sheet.x);
  expect(slots.x + slots.width).toBeLessThanOrEqual(sheet.x + sheet.width);
  expect(sheet.y + sheet.height).toBeLessThanOrEqual(720);
});

test("the singer's creature shows beside the name; in an accepted Duet both show", async ({ browser, page, request }) => {
  const room = await createRoom(request);
  await page.setViewportSize({ width: 1280, height: 720 });
  // Bia is in the Room (a phone connected), so she can be invited
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
  expect(await clippedBlobs(page)).toEqual([]); // no creature clipped by the name line's height
  // the Duet's name shows whole (it wraps to two lines if needed, instead of becoming "…")
  expect(await page.locator('.singer.is-now .who-name').evaluate((el) => el.scrollHeight - el.clientHeight < parseFloat(getComputedStyle(el).lineHeight) / 2 && el.scrollWidth <= el.clientWidth + 1)).toBe(true);

  // on the phone, the song playing and the Queue show both too
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await phone.addInitScript(() => { localStorage.setItem('clientId', 'client-caio-0001'); localStorage.setItem('userName', 'Caio'); });
  const caio = await phone.newPage();
  await caio.goto(room.guestUrl);
  await expect(caio.locator('.now-singer .singer-blobs.duo img.blob')).toHaveCount(2);
  expect(await clippedBlobs(caio)).toEqual([]);
  await phone.close();
});
