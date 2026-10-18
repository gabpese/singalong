// Intervalo entre músicas: aplausos para quem acabou de cantar e a subida ao palco de quem vem (no servidor de testes cada fase
// dura 3 s e as salas nascem com o intervalo desligado; estes testes o ligam).
import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { addToQueue, ANA, BIA, createRoom, hostPatch, roomState, SONGS } from './helpers.mjs';

const violations = async (page) =>
  (await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze()).violations.map((v) => `${v.id}: ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(' | ')}`);
// o intervalo só acontece com a TV conectada: os testes esperam a TV entrar na sala antes de pôr a primeira música na fila
const tvConnected = (request, room) => expect.poll(async () => (await roomState(request, room.code)).tv_connected).toBe(true);
const playing = (page) => page.evaluate(() => window.tv.engine.playing && window.tv.engine.currentTime > 0);
const finishSong = (page) => page.evaluate(() => window.tv.engine.seek(window.tv.engine.duration - 0.3));

test('a TV mostra a subida ao palco com a contagem (o som espera), depois toca; no fim, aplausos e o próximo sobe', async ({ page, request }) => {
  const room = await createRoom(request);
  await hostPatch(request, room, { intermission: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(room.tvUrl);
  await tvConnected(request, room);
  await addToQueue(request, room.code, SONGS.alpha, { client: ANA, name: 'Ana' });
  await addToQueue(request, room.code, SONGS.bravo, { client: BIA, name: 'Bia' });

  const stage = page.locator('.interlude.stage-up');
  await expect(stage).toBeVisible();
  await expect(stage.getByText('Próximo no palco')).toBeVisible();
  await expect(stage.locator('.interlude-who')).toHaveText('Ana');
  await expect(stage.getByRole('timer')).toContainText('Começa em');
  await expect(stage.locator('.walker .singer-blobs .blob')).toHaveCount(1); // o bichinho de quem vai cantar sobe a escada
  expect(await playing(page)).toBe(false); // a música já foi escolhida, mas espera o cantor chegar
  await page.waitForTimeout(700); // a cena entra com um fade de 0,5 s: o contraste vale com ela inteira na tela
  expect(await violations(page)).toEqual([]);
  await expect(stage).toBeHidden({ timeout: 6000 });
  await expect.poll(() => playing(page)).toBe(true);

  await finishSong(page);
  const applause = page.locator('.interlude.applause');
  await expect(applause).toBeVisible();
  await expect(applause.getByText('Aplausos para')).toBeVisible();
  await expect(applause.locator('.interlude-who')).toContainText('Ana');
  await expect(applause.locator('.crowd .crowd-blob')).toHaveCount(14); // a plateia
  await page.waitForTimeout(700); // a cena entra com um fade de 0,5 s: o contraste vale com ela inteira na tela
  expect(await violations(page)).toEqual([]);
  expect(await playing(page)).toBe(false);
  // depois dos aplausos, a Bia sobe ao palco
  await expect(page.locator('.interlude.stage-up .interlude-who')).toHaveText('Bia', { timeout: 6000 });
});

test('o celular mostra o intervalo; o anfitrião pula com "Começar agora" e o palco de quem canta chama a pessoa', async ({ browser, page, request }) => {
  const room = await createRoom(request);
  await hostPatch(request, room, { intermission: true });
  await page.goto(room.tvUrl);
  const phone = async (client, name, url) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await context.addInitScript(([c, n]) => { localStorage.setItem('clientId', c); localStorage.setItem('userName', n); }, [client, name]);
    const p = await context.newPage();
    await p.goto(url);
    return { page: p, close: () => context.close() };
  };
  const host = await phone('client-host-0001', 'Gabi', room.hostUrl);
  const ana = await phone(ANA, 'Ana', room.guestUrl);
  await tvConnected(request, room);
  await addToQueue(request, room.code, SONGS.alpha, { client: ANA, name: 'Ana' });

  // quem vai cantar é levado ao palco, e lá está o chamado com a contagem
  await expect(ana.page).toHaveURL(/\/stage\.html/);
  await expect(ana.page.getByText('Sua vez. Suba ao palco.')).toBeVisible();
  await expect(ana.page.getByText(/A música começa em \d+ s/)).toBeVisible();

  // na sala, o aviso; o anfitrião pula o intervalo e a música começa na hora
  const banner = host.page.locator('.interlude-banner');
  await expect(banner).toContainText('Ana está subindo ao palco');
  await banner.getByRole('button', { name: 'Começar agora' }).click();
  await expect.poll(async () => (await roomState(request, room.code)).playback).toBe('playing');
  await expect(banner).toBeHidden();
  await expect(ana.page.getByText('Sua vez. Suba ao palco.')).toBeHidden();
  await host.close();
  await ana.close();
});

test('o anfitrião liga e desliga o intervalo na barra lateral; quem não é anfitrião não vê o interruptor', async ({ browser, page, request }) => {
  const room = await createRoom(request);
  await page.goto(room.hostUrl);
  const toggle = page.getByRole('switch', { name: 'Intervalo entre músicas' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false'); // as salas dos testes nascem com ele desligado
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect.poll(async () => (await roomState(request, room.code)).intermission).toBe(true);
  const context = await browser.newContext();
  const guest = await context.newPage();
  await guest.goto(room.guestUrl);
  await expect(guest.getByRole('heading', { name: `Sala ${room.code}` })).toBeVisible();
  await expect(guest.getByRole('switch', { name: 'Intervalo entre músicas' })).toHaveCount(0);
  await context.close();
});
