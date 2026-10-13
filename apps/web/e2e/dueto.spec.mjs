// Dueto: o dono da música convida alguém que está na sala, a pessoa aceita, e na vez da música os DOIS vão para o palco, com a
// letra em duas cores (turquesa e violeta, amarelo quando cantam juntos), cada parte com a sua forma.
import { expect, test } from '@playwright/test';
import { addToQueue, ANA, BIA, createRoom, SONGS } from './helpers.mjs';

test.use({ viewport: { width: 390, height: 844 } });

const CAIO = 'client-caio-0001';

/** Uma pessoa no celular: o client_id e o nome dela ficam no navegador (o nome é o que aparece na lista de quem está na sala). */
async function phone(browser, client, name) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(([id, who]) => {
    localStorage.setItem('clientId', id);
    localStorage.setItem('userName', who);
  }, [client, name]);
  return { context, page: await context.newPage() };
}

const tvPlaying = (page) => page.evaluate(() => window.tv.engine.playing && window.tv.engine.duration > 0 && window.tv.engine.currentTime > 0);
const hostPost = (request, room, path) => request.post(`/api/rooms/${room.code}${path}`, { headers: { 'x-client-id': ANA, 'x-host-token': room.host } });

test('convidar, aceitar e cantar junto: os dois vão ao palco e a letra tem as duas cores', async ({ browser, page: tv, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: CAIO, name: 'Caio' }); // toca primeiro; a da Ana aguarda
  await addToQueue(request, room.code, SONGS.bravo, { client: ANA, name: 'Ana' });

  const ana = await phone(browser, ANA, 'Ana');
  const bia = await phone(browser, BIA, 'Bia');
  await ana.page.goto(room.guestUrl);
  await bia.page.goto(room.guestUrl);

  // a Ana convida a Bia (que está na sala): a lista mostra quem está aqui, menos ela mesma
  await ana.page.getByRole('button', { name: 'Convidar para cantar junto' }).click();
  const dialog = ana.page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Bia' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Ana' })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Bia' }).click();
  await expect(ana.page.getByText('Convite enviado para Bia, aguardando…')).toBeVisible();

  // a Bia vê o pedido, na hora, e aceita
  const invite = bia.page.getByRole('alert', { name: 'Convites para cantar junto' });
  await expect(invite).toContainText('Ana convidou você para cantar');
  await invite.getByRole('button', { name: 'Aceitar' }).click();
  await expect(invite).toHaveCount(0);
  await expect(bia.page.getByText('Dueto com Ana ✓')).toBeVisible();
  await expect(ana.page.getByText('Dueto com Bia ✓')).toBeVisible();

  // a TV toca a primeira música; o anfitrião pula e entra a dupla
  await tv.goto(room.tvUrl);
  await expect.poll(() => tvPlaying(tv)).toBe(true);
  await hostPost(request, room, '/player/skip');

  // os dois vão da sala para o palco
  await expect(ana.page).toHaveURL(/\/stage\.html/, { timeout: 10_000 });
  await expect(bia.page).toHaveURL(/\/stage\.html/, { timeout: 10_000 });
  await expect(ana.page.locator('.stage-artist')).toContainText('Ana & Bia');

  // a letra do palco: a 1ª linha é da Ana (turquesa), a 2ª da Bia (violeta)
  await expect(ana.page.locator('.line.current')).toContainText('Primeira linha da letra');
  await expect(ana.page.locator('.line.current')).toHaveAttribute('data-part', 'a');
  await expect(ana.page.locator('.line.next')).toHaveAttribute('data-part', 'b');
  await expect(bia.page.locator('.line.current')).toHaveAttribute('data-part', 'a');
  // cada um vê qual é a sua cor
  await expect(ana.page.locator('.stage-legend')).toContainText('Você canta nas partes turquesa');
  await expect(bia.page.locator('.stage-legend')).toContainText('Você canta nas partes violeta');
  // o layout: o cartão da letra não fica colado na base; tem espaço livre acima e abaixo e a legenda vem logo depois dele
  const box = await ana.page.evaluate(() => {
    const rect = (selector) => document.querySelector(selector).getBoundingClientRect();
    const card = rect('.stage-lyrics');
    return { above: card.top - rect('.stage-duet').bottom, legendGap: rect('.stage-legend').top - card.bottom, height: card.height, viewport: innerHeight };
  });
  expect(box.above).toBeGreaterThan(40);
  expect(box.legendGap).toBeLessThan(40);
  expect(box.height).toBeLessThan(box.viewport * 0.6);
  // as cores (seguras para daltonismo), a forma de cada parte
  const look = await ana.page.evaluate(() => {
    const read = (selector, name) => getComputedStyle(document.querySelector(selector)).getPropertyValue(name).trim().toLowerCase();
    return { a: read('.line.current', '--part'), b: read('.line.next', '--part'), shapeA: read('.line.current', '--shape'), shapeB: read('.line.next', '--shape') };
  });
  expect(look.a).toBe('#10b8c8');
  expect(look.b).toBe('#8b5cf6');
  expect([look.shapeA, look.shapeB].map((s) => s.replace(/["']/g, ''))).toEqual(['●', '■']); // a cor nunca é a única pista
  

  // a TV mostra os dois nomes, as cores e a mesma divisão
  await expect(tv.locator('.duet-legend')).toContainText('Ana');
  await expect(tv.locator('.duet-legend')).toContainText('Bia');
  await expect(tv.locator('.line.current')).toHaveAttribute('data-part', 'a');

  // quando acaba, os dois voltam para a sala
  await hostPost(request, room, '/player/skip');
  await expect(ana.page).toHaveURL(/\/room\.html/, { timeout: 12_000 });
  await expect(bia.page).toHaveURL(/\/room\.html/, { timeout: 12_000 });
  await ana.context.close();
  await bia.context.close();
});

test('recusar desfaz o convite; quem não foi convidado não vê o pedido e a Ana continua sozinha na música', async ({ browser, request }) => {
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
  await expect(ana.page.getByRole('button', { name: 'Convidar para cantar junto' })).toBeVisible(); // voltou a poder convidar
  await expect(ana.page.getByText('Dueto com')).toHaveCount(0);

  // convidar e cancelar
  await ana.page.getByRole('button', { name: 'Convidar para cantar junto' }).click();
  await ana.page.getByRole('dialog').getByRole('button', { name: 'Bia' }).click();
  await expect(bia.page.getByRole('alert', { name: 'Convites para cantar junto' })).toBeVisible();
  await ana.page.getByRole('button', { name: 'Cancelar o convite' }).click();
  await expect(bia.page.getByRole('alert', { name: 'Convites para cantar junto' })).toHaveCount(0);
  for (const person of [ana, bia, caio]) await person.context.close();
});

test('sem mais ninguém na sala o convite avisa que não há quem convidar', async ({ browser, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: CAIO, name: 'Caio' });
  await addToQueue(request, room.code, SONGS.bravo, { client: ANA, name: 'Ana' });
  const ana = await phone(browser, ANA, 'Ana');
  await ana.page.goto(room.guestUrl);
  await ana.page.getByRole('button', { name: 'Convidar para cantar junto' }).click();
  await expect(ana.page.getByRole('dialog')).toContainText('Ninguém mais está na sala agora');
  await ana.context.close();
});

test('convite com a música JÁ TOCANDO: aparece em qualquer tela do convidado e, ao aceitar, ele entra no dueto no meio dela', async ({ browser, page: tv, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: ANA, name: 'Ana' }); // a única música: toca na hora
  await tv.goto(room.tvUrl);
  await expect.poll(() => tvPlaying(tv)).toBe(true);
  await expect(tv.locator('.lyrics [data-part]')).toHaveCount(0); // ainda é uma música comum

  const ana = await phone(browser, ANA, 'Ana');
  const bia = await phone(browser, BIA, 'Bia');
  await bia.page.goto(room.guestUrl);
  await ana.page.goto(room.guestUrl);
  await expect(ana.page).toHaveURL(/\/stage\.html/); // a Ana está cantando, no palco

  // da própria tela do palco ela convida a Bia, com a música já tocando
  await ana.page.getByRole('button', { name: 'Convidar para cantar junto' }).click();
  await ana.page.getByRole('dialog').getByRole('button', { name: 'Bia' }).click();
  await expect(ana.page.getByText('Convite enviado para Bia, aguardando…')).toBeVisible();

  // o aviso chega à Bia onde quer que ela esteja: fila, adicionar e Jukebox
  const notice = bia.page.getByRole('alert', { name: 'Convites para cantar junto' });
  await expect(notice).toContainText('Ana convidou você para cantar');
  await expect(notice).toContainText('ela já está tocando');
  for (const tab of ['Adicionar', 'Músicas', 'Fila']) {
    await bia.page.getByRole('navigation', { name: 'Seções' }).getByRole('button', { name: tab }).click();
    await expect(notice).toBeVisible();
  }
  await bia.page.getByRole('navigation', { name: 'Seções' }).getByRole('button', { name: 'Músicas' }).click();
  await notice.getByRole('button', { name: 'Aceitar' }).click(); // aceita estando na Jukebox

  // a Bia vai para o palco, a Ana vê a dupla e a TV passa a pintar a letra com as duas cores, no meio da música
  await expect(bia.page).toHaveURL(/\/stage\.html/, { timeout: 10_000 });
  await expect(ana.page.getByText('Dueto com Bia ✓')).toBeVisible();
  await expect(ana.page.locator('.stage-artist')).toContainText('Ana & Bia');
  await expect(tv.locator('.duet-legend')).toContainText('Bia');
  await expect(tv.locator('.lyrics [data-part]').first()).toBeVisible();
  await ana.context.close();
  await bia.context.close();
});

test('o aviso também chega a quem está no palco (e recusar não tira ninguém dele)', async ({ browser, page: tv, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: CAIO, name: 'Caio' }); // o Caio canta agora, no palco
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
  await expect(notice).toContainText('Ana convidou você para cantar'); // no palco, no meio da música dele
  await notice.getByRole('button', { name: 'Recusar' }).click();
  await expect(notice).toHaveCount(0);
  expect(caio.page.url()).toContain('/stage.html'); // continua cantando
  await ana.context.close();
  await caio.context.close();
});

test('o aviso também aparece na TV de quem usa o navegador dela como a própria tela (e dá para aceitar ali)', async ({ browser, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: CAIO, name: 'Caio' });
  await addToQueue(request, room.code, SONGS.bravo, { client: ANA, name: 'Ana' });
  const ana = await phone(browser, ANA, 'Ana');
  const bia = await phone(browser, BIA, 'Bia');
  await bia.page.goto(room.guestUrl); // a Bia aparece na lista de quem está na sala
  await ana.page.goto(room.guestUrl);
  await ana.page.getByRole('button', { name: 'Convidar para cantar junto' }).click();
  await ana.page.getByRole('dialog').getByRole('button', { name: 'Bia' }).click();

  // a TV da Bia: o navegador dela (mesmo client_id) abre a TV, como no app do dono (as abas TV e Anfitrião dividem a identidade)
  const tvBia = await phone(browser, BIA, 'Bia');
  await tvBia.page.goto(room.tvUrl);
  const notice = tvBia.page.getByRole('alert', { name: 'Convites para cantar junto' });
  await expect(notice).toContainText('Ana convidou você');
  await notice.getByRole('button', { name: 'Aceitar' }).click();
  await expect(notice).toHaveCount(0);
  await expect(ana.page.getByText('Dueto com Bia ✓')).toBeVisible();
  for (const person of [ana, bia, tvBia]) await person.context.close();
});
