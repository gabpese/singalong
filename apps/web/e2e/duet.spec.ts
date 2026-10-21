// A Duet: the song's owner invites someone in the Room, the person accepts, and when the song comes up BOTH go to the Stage,
// with the lyrics in two colors (turquoise and violet, yellow when they sing together), each part with its own shape.
import { type APIRequestContext, type Browser, expect, type Page, test } from '@playwright/test';
import { addToQueue, ANA, BIA, createRoom, SONGS, type TestRoom } from './helpers.ts';

test.use({ viewport: { width: 390, height: 844 } });

const CAIO = 'client-caio-0001';

/** A person on a phone: their client_id and name stay in the browser (the name is what shows in the list of who is in the Room). */
async function phone(browser: Browser, client: string, name: string) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(([id, who]) => {
    localStorage.setItem('clientId', id);
    localStorage.setItem('userName', who);
  }, [client, name]);
  return { context, page: await context.newPage() };
}

const tvPlaying = (page: Page) => page.evaluate(() => window.tv.engine.playing && window.tv.engine.duration > 0 && window.tv.engine.currentTime > 0);
const hostPost = (request: APIRequestContext, room: TestRoom, path: string) => request.post(`/api/rooms/${room.code}${path}`, { headers: { 'x-client-id': ANA, 'x-host-token': room.host } });

test('inviting, accepting and singing together: both go to the Stage and the lyrics have both colors', async ({ browser, page: tv, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: CAIO, name: 'Caio' }); // plays first; Ana's waits
  await addToQueue(request, room.code, SONGS.bravo, { client: ANA, name: 'Ana' });

  const ana = await phone(browser, ANA, 'Ana');
  const bia = await phone(browser, BIA, 'Bia');
  await ana.page.goto(room.guestUrl);
  await bia.page.goto(room.guestUrl);

  // Ana invites Bia (who is in the Room): the list shows who is here, except herself
  await ana.page.getByRole('button', { name: 'Convidar para cantar junto' }).click();
  const dialog = ana.page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Bia' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Ana' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Bia' }).click();
  await expect(ana.page.getByText('Convite enviado para Bia, aguardando…')).toBeVisible();

  // Bia sees the request at once, and accepts
  const invite = bia.page.getByRole('alert', { name: 'Convites para cantar junto' });
  await expect(invite).toContainText('Ana convidou você para cantar');
  await invite.getByRole('button', { name: 'Aceitar' }).click();
  await expect(invite).toHaveCount(0);
  await expect(bia.page.getByText('Dueto com Ana ✓')).toBeVisible();
  await expect(ana.page.getByText('Dueto com Bia ✓')).toBeVisible();

  // the TV plays the first song; the Host skips and the pair comes in
  await tv.goto(room.tvUrl);
  await expect.poll(() => tvPlaying(tv)).toBe(true);
  await hostPost(request, room, '/player/skip');

  // both go from the Room to the Stage
  await expect(ana.page).toHaveURL(/\/stage\.html/, { timeout: 10_000 });
  await expect(bia.page).toHaveURL(/\/stage\.html/, { timeout: 10_000 });
  await expect(ana.page.locator('.stage-artist')).toContainText('Ana & Bia');

  // the Stage's lyrics: the 1st line is Ana's (turquoise), the 2nd Bia's (violet)
  await expect(ana.page.locator('.line.current')).toContainText('Primeira linha da letra');
  await expect(ana.page.locator('.line.current')).toHaveAttribute('data-part', 'a');
  await expect(ana.page.locator('.line.next')).toHaveAttribute('data-part', 'b');
  await expect(bia.page.locator('.line.current')).toHaveAttribute('data-part', 'a');
  // each one sees which is their color
  await expect(ana.page.locator('.stage-legend')).toContainText('Você canta nas partes turquesa');
  await expect(bia.page.locator('.stage-legend')).toContainText('Você canta nas partes violeta');
  // the layout: the lyrics card does not stick to the bottom; it has free room above and below, and the legend comes right after it
  const box = await ana.page.evaluate(() => {
    const rect = (selector: string) => document.querySelector(selector)!.getBoundingClientRect();
    const card = rect('.stage-lyrics');
    return { above: card.top - rect('.stage-duet').bottom, legendGap: rect('.stage-legend').top - card.bottom, height: card.height, viewport: innerHeight };
  });
  expect(box.above).toBeGreaterThan(40);
  expect(box.legendGap).toBeLessThan(40);
  expect(box.height).toBeLessThan(box.viewport * 0.6);
  // the colors (safe for color blindness), each part's shape
  const look = await ana.page.evaluate(() => {
    const read = (selector: string, name: string) => getComputedStyle(document.querySelector(selector)!).getPropertyValue(name).trim().toLowerCase();
    return { a: read('.line.current', '--part'), b: read('.line.next', '--part'), shapeA: read('.line.current', '--shape'), shapeB: read('.line.next', '--shape') };
  });
  expect(look.a).toBe('#10b8c8');
  expect(look.b).toBe('#8b5cf6');
  expect([look.shapeA, look.shapeB].map((s) => s.replace(/["']/g, ''))).toEqual(['●', '■']); // color is never the only cue

  // the TV shows both names, the colors and the same split
  await expect(tv.locator('.duet-legend')).toContainText('Ana');
  await expect(tv.locator('.duet-legend')).toContainText('Bia');
  await expect(tv.locator('.line.current')).toHaveAttribute('data-part', 'a');

  // when it ends, both go back to the Room
  await hostPost(request, room, '/player/skip');
  await expect(ana.page).toHaveURL(/\/room\.html/, { timeout: 12_000 });
  await expect(bia.page).toHaveURL(/\/room\.html/, { timeout: 12_000 });
  await ana.context.close();
  await bia.context.close();
});

test("declining undoes the invitation; whoever was not invited does not see the request, and Ana stays alone in the song", async ({ browser, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: CAIO, name: 'Caio' });
  await addToQueue(request, room.code, SONGS.bravo, { client: ANA, name: 'Ana' });
  const ana = await phone(browser, ANA, 'Ana');
  const bia = await phone(browser, BIA, 'Bia');
  const caio = await phone(browser, CAIO, 'Caio');
  for (const person of [ana, bia, caio]) await person.page.goto(room.guestUrl);

  await ana.page.getByRole('button', { name: 'Convidar para cantar junto' }).click();
  await ana.page.getByRole('dialog').getByRole('button', { name: 'Bia' }).click();
  await expect(bia.page.getByRole('alert', { name: 'Convites para cantar junto' })).toBeVisible();
  await expect(caio.page.getByRole('alert', { name: 'Convites para cantar junto' })).toHaveCount(0);

  await bia.page.getByRole('button', { name: 'Recusar' }).click();
  await expect(bia.page.getByRole('alert', { name: 'Convites para cantar junto' })).toHaveCount(0);
  await expect(ana.page.getByRole('button', { name: 'Convidar para cantar junto' })).toBeVisible(); // she can invite again
  await expect(ana.page.getByText('Dueto com')).toHaveCount(0);

  // inviting and cancelling
  await ana.page.getByRole('button', { name: 'Convidar para cantar junto' }).click();
  await ana.page.getByRole('dialog').getByRole('button', { name: 'Bia' }).click();
  await expect(bia.page.getByRole('alert', { name: 'Convites para cantar junto' })).toBeVisible();
  await ana.page.getByRole('button', { name: 'Cancelar o convite' }).click();
  await expect(bia.page.getByRole('alert', { name: 'Convites para cantar junto' })).toHaveCount(0);
  for (const person of [ana, bia, caio]) await person.context.close();
});

test('with nobody else in the Room the invitation says there is no one to invite', async ({ browser, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: CAIO, name: 'Caio' });
  await addToQueue(request, room.code, SONGS.bravo, { client: ANA, name: 'Ana' });
  const ana = await phone(browser, ANA, 'Ana');
  await ana.page.goto(room.guestUrl);
  await ana.page.getByRole('button', { name: 'Convidar para cantar junto' }).click();
  await expect(ana.page.getByRole('dialog')).toContainText('Ninguém mais está na sala agora');
  await ana.context.close();
});

test("an invitation with the song ALREADY PLAYING: it shows on any of the guest's screens and, on accepting, they join the Duet midway", async ({ browser, page: tv, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: ANA, name: 'Ana' }); // the only song: it plays at once
  await tv.goto(room.tvUrl);
  await expect.poll(() => tvPlaying(tv)).toBe(true);
  await expect(tv.locator('.lyrics [data-part]')).toHaveCount(0); // still a regular song

  const ana = await phone(browser, ANA, 'Ana');
  const bia = await phone(browser, BIA, 'Bia');
  await bia.page.goto(room.guestUrl);
  await ana.page.goto(room.guestUrl);
  await expect(ana.page).toHaveURL(/\/stage\.html/); // Ana is singing, on the Stage

  // from the Stage's own screen she invites Bia, with the song already playing
  await ana.page.getByRole('button', { name: 'Convidar para cantar junto' }).click();
  await ana.page.getByRole('dialog').getByRole('button', { name: 'Bia' }).click();
  await expect(ana.page.getByText('Convite enviado para Bia, aguardando…')).toBeVisible();

  // the notice reaches Bia wherever she is: the Queue, adding a song and the Jukebox
  const notice = bia.page.getByRole('alert', { name: 'Convites para cantar junto' });
  await expect(notice).toContainText('Ana convidou você para cantar');
  await expect(notice).toContainText('ela já está tocando');
  for (const tab of ['Adicionar', 'Jukebox', 'Fila']) {
    await bia.page.getByRole('navigation', { name: 'Seções' }).getByRole('button', { name: tab }).click();
    await expect(notice).toBeVisible();
  }
  await bia.page.getByRole('navigation', { name: 'Seções' }).getByRole('button', { name: 'Jukebox' }).click();
  await notice.getByRole('button', { name: 'Aceitar' }).click(); // accepts while in the Jukebox

  // Bia goes to the Stage, Ana sees the pair, and the TV starts painting the lyrics in both colors, midway through the song
  await expect(bia.page).toHaveURL(/\/stage\.html/, { timeout: 10_000 });
  await expect(ana.page.getByText('Dueto com Bia ✓')).toBeVisible();
  await expect(ana.page.locator('.stage-artist')).toContainText('Ana & Bia');
  await expect(tv.locator('.duet-legend')).toContainText('Bia');
  await expect(tv.locator('.lyrics [data-part]').first()).toBeVisible();
  await ana.context.close();
  await bia.context.close();
});

test('the notice reaches whoever is on the Stage too (and declining takes nobody off it)', async ({ browser, page: tv, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: CAIO, name: 'Caio' }); // Caio sings now, on the Stage
  await addToQueue(request, room.code, SONGS.bravo, { client: ANA, name: 'Ana' });
  await tv.goto(room.tvUrl);
  await expect.poll(() => tvPlaying(tv)).toBe(true);
  const caio = await phone(browser, CAIO, 'Caio');
  await caio.page.goto(room.guestUrl);
  await expect(caio.page).toHaveURL(/\/stage\.html/);

  const ana = await phone(browser, ANA, 'Ana');
  await ana.page.goto(room.guestUrl);
  await ana.page.getByRole('button', { name: 'Convidar para cantar junto' }).click();
  await ana.page.getByRole('dialog').getByRole('button', { name: 'Caio' }).click();

  const notice = caio.page.getByRole('alert', { name: 'Convites para cantar junto' });
  await expect(notice).toContainText('Ana convidou você para cantar'); // on the Stage, in the middle of his song
  await notice.getByRole('button', { name: 'Recusar' }).click();
  await expect(notice).toHaveCount(0);
  expect(caio.page.url()).toContain('/stage.html'); // he goes on singing
  await ana.context.close();
  await caio.context.close();
});

test("the notice shows on the TV of whoever uses their browser as their own screen too (and they can accept there)", async ({ browser, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: CAIO, name: 'Caio' });
  await addToQueue(request, room.code, SONGS.bravo, { client: ANA, name: 'Ana' });
  const ana = await phone(browser, ANA, 'Ana');
  const bia = await phone(browser, BIA, 'Bia');
  await bia.page.goto(room.guestUrl); // Bia shows in the list of who is in the Room
  await ana.page.goto(room.guestUrl);
  await ana.page.getByRole('button', { name: 'Convidar para cantar junto' }).click();
  await ana.page.getByRole('dialog').getByRole('button', { name: 'Bia' }).click();

  // Bia's TV: her browser (the same client_id) opens the TV, as in the owner's app (the TV and Host tabs share the identity)
  const tvBia = await phone(browser, BIA, 'Bia');
  await tvBia.page.goto(room.tvUrl);
  const notice = tvBia.page.getByRole('alert', { name: 'Convites para cantar junto' });
  await expect(notice).toContainText('Ana convidou você');
  await notice.getByRole('button', { name: 'Aceitar' }).click();
  await expect(notice).toHaveCount(0);
  await expect(ana.page.getByText('Dueto com Bia ✓')).toBeVisible();
  for (const person of [ana, bia, tvBia]) await person.context.close();
});
