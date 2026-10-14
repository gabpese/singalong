// Dueto com vozes identificadas: os cantores escolhem quem canta cada linha da letra e isso vale na TV e no palco.
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { addToQueue, ANA, BIA, createRoom, roomState, SONGS } from './helpers.mjs';

const CAIO = 'client-caio-0001';

async function phone(browser, client, name) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(([id, who]) => {
    localStorage.setItem('clientId', id);
    localStorage.setItem('userName', who);
  }, [client, name]);
  return { context, page: await context.newPage() };
}

// a divisão vale para a música em qualquer sala (e o servidor de teste é um só): cada teste a devolve ao automático no fim
let lastRoom = null;
test.afterEach(async ({ request }) => {
  if (!lastRoom) return;
  await request.put(`/api/rooms/${lastRoom.code}/songs/${SONGS.bravo.id}/parts`, { headers: { 'x-client-id': ANA, 'x-host-token': lastRoom.host }, data: { parts: null } });
  lastRoom = null;
});

const tvPlaying = (page) => page.evaluate(() => window.tv.engine.playing && window.tv.engine.duration > 0 && window.tv.engine.currentTime > 0);

/** Uma sala com a música do Caio tocando e a da Ana (em dueto com a Bia) aguardando. */
async function duetRoom(browser, request) {
  const room = await createRoom(request);
  lastRoom = room;
  await addToQueue(request, room.code, SONGS.alpha, { client: CAIO, name: 'Caio' });
  const itemId = await addToQueue(request, room.code, SONGS.bravo, { client: ANA, name: 'Ana' });
  const ana = await phone(browser, ANA, 'Ana');
  const bia = await phone(browser, BIA, 'Bia');
  await ana.page.goto(room.guestUrl);
  await bia.page.goto(room.guestUrl);
  await ana.page.getByRole('button', { name: 'Convidar para cantar junto' }).click();
  await ana.page.getByRole('dialog').getByRole('button', { name: 'Bia' }).click();
  await bia.page.getByRole('alert', { name: 'Convites para cantar junto' }).getByRole('button', { name: 'Aceitar' }).click();
  await expect(ana.page.getByText('Dueto com Bia ✓')).toBeVisible();
  return { room, itemId, ana, bia };
}

test('o dono e o convidado dividem a letra; a escolha vai para o servidor e volta ao automático', async ({ browser, request }) => {
  const { room, itemId, ana, bia } = await duetRoom(browser, request);
  const itemNow = async () => (await roomState(request, room.code)).queue.find((i) => i.id === itemId);
  expect((await itemNow()).parts).toBeNull(); // automático

  await ana.page.getByRole('button', { name: 'Dividir a letra' }).click();
  const dialog = ana.page.getByRole('dialog', { name: 'Quem canta cada linha' });
  await expect(dialog.getByText('Primeira linha da letra')).toBeVisible();
  // a divisão automática já vem marcada: linha 1 = voz 1, linha 2 = voz 2, linha 3 = voz 1
  const line = (n) => dialog.getByRole('radiogroup', { name: `Quem canta a linha ${n}` });
  await expect(line(1).getByRole('radio', { name: 'Voz 1' })).toHaveAttribute('aria-checked', 'true');
  await expect(line(2).getByRole('radio', { name: 'Voz 2' })).toHaveAttribute('aria-checked', 'true');

  const axe = await new AxeBuilder({ page: ana.page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
  await line(1).getByRole('radio', { name: 'Voz 2' }).click();
  await line(2).getByRole('radio', { name: 'Juntos' }).click();
  await expect(line(1).getByRole('radio', { name: 'Voz 1' })).toHaveAttribute('aria-checked', 'false');
  await dialog.getByRole('button', { name: 'Salvar a divisão' }).click();
  await expect(ana.page.getByText('Divisão da letra salva.')).toBeVisible();
  await expect.poll(async () => (await itemNow()).parts).toBe('b*a');

  // o convidado também vê o botão e a divisão que ficou salva
  await bia.page.getByRole('button', { name: 'Dividir a letra' }).click();
  const biaDialog = bia.page.getByRole('dialog', { name: 'Quem canta cada linha' });
  await expect(biaDialog.getByRole('radiogroup', { name: 'Quem canta a linha 1' }).getByRole('radio', { name: 'Voz 2' })).toHaveAttribute('aria-checked', 'true');
  await biaDialog.getByRole('button', { name: 'Voltar ao automático' }).click();
  await expect(bia.page.getByText('Voltou à divisão automática.')).toBeVisible();
  await expect.poll(async () => (await itemNow()).parts).toBeNull();
  for (const p of [ana, bia]) await p.context.close();
});

test('na vez da música, a TV e o palco pintam as linhas como os cantores dividiram', async ({ browser, page: tv, request }) => {
  const { room, itemId, ana, bia } = await duetRoom(browser, request);
  await ana.page.getByRole('button', { name: 'Dividir a letra' }).click();
  const dialog = ana.page.getByRole('dialog', { name: 'Quem canta cada linha' });
  await dialog.getByRole('radiogroup', { name: 'Quem canta a linha 1' }).getByRole('radio', { name: 'Juntos' }).click();
  await dialog.getByRole('radiogroup', { name: 'Quem canta a linha 2' }).getByRole('radio', { name: 'Voz 1' }).click();
  await dialog.getByRole('button', { name: 'Salvar a divisão' }).click();
  await expect.poll(async () => (await roomState(request, room.code)).queue.find((i) => i.id === itemId).parts).toBe('*aa');

  await tv.goto(room.tvUrl);
  await expect.poll(() => tvPlaying(tv)).toBe(true);
  await request.post(`/api/rooms/${room.code}/player/skip`, { headers: { 'x-client-id': ANA, 'x-host-token': room.host } }); // a dupla entra
  await expect(ana.page).toHaveURL(/\/stage\.html/, { timeout: 10_000 });
  await expect(ana.page.locator('.line.current')).toContainText('Primeira linha da letra');
  await expect(ana.page.locator('.line.current')).toHaveAttribute('data-part', 'both'); // linha 1: juntos
  await expect(ana.page.locator('.line.next')).toHaveAttribute('data-part', 'a'); // linha 2: voz 1
  await expect(tv.locator('.line.current')).toHaveAttribute('data-part', 'both'); // e a TV pinta igual
  for (const p of [ana, bia]) await p.context.close();
});

test('quem não canta a música não vê o botão de dividir a letra', async ({ browser, request }) => {
  const { room, ana, bia } = await duetRoom(browser, request);
  const caio = await phone(browser, CAIO, 'Caio');
  await caio.page.goto(room.guestUrl);
  await expect(caio.page.getByText('Wicked Game').first()).toBeVisible();
  await expect(caio.page.getByRole('button', { name: 'Dividir a letra' })).toHaveCount(0);
  for (const p of [ana, bia, caio]) await p.context.close();
});
