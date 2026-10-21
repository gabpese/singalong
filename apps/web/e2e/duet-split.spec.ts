// A Duet with named voices: the singers choose who sings each line of the lyrics, and that holds on the TV and on the Stage.
import { type APIRequestContext, type Browser, expect, type Page, test } from '@playwright/test';
import { addToQueue, ANA, AxeBuilder, BIA, createRoom, roomState, SONGS, type TestRoom } from './helpers.ts';

const CAIO = 'client-caio-0001';

async function phone(browser: Browser, client: string, name: string) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await context.addInitScript(([id, who]) => {
    localStorage.setItem('clientId', id);
    localStorage.setItem('userName', who);
  }, [client, name]);
  return { context, page: await context.newPage() };
}

// the split holds for the song in any Room (and there is a single test server): each test puts it back to automatic at its end
let lastRoom: TestRoom | null = null;
test.afterEach(async ({ request }) => {
  if (!lastRoom) return;
  await request.put(`/api/rooms/${lastRoom.code}/songs/${SONGS.bravo.id}/parts`, { headers: { 'x-client-id': ANA, 'x-host-token': lastRoom.host }, data: { parts: null } });
  lastRoom = null;
});

const tvPlaying = (page: Page) => page.evaluate(() => window.tv.engine.playing && window.tv.engine.duration > 0 && window.tv.engine.currentTime > 0);

/** A Room with Caio's song playing and Ana's (in a Duet with Bia) waiting. */
async function duetRoom(browser: Browser, request: APIRequestContext) {
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

test('the owner and the guest split the lyrics; the choice goes to the server and back to automatic', async ({ browser, request }) => {
  const { room, itemId, ana, bia } = await duetRoom(browser, request);
  const itemNow = async () => (await roomState(request, room.code)).queue.find((i) => i.id === itemId);
  expect((await itemNow())?.parts).toBeNull(); // automatic

  await ana.page.getByRole('button', { name: 'Dividir a letra' }).click();
  const dialog = ana.page.getByRole('dialog', { name: 'Quem canta cada linha' });
  await expect(dialog.getByText('Primeira linha da letra')).toBeVisible();
  // the automatic split comes already marked: line 1 = voice 1, line 2 = voice 2, line 3 = voice 1
  const line = (n: number) => dialog.getByRole('radiogroup', { name: `Quem canta a linha ${n}` });
  await expect(line(1).getByRole('radio', { name: 'Voz 1' })).toHaveAttribute('aria-checked', 'true');
  await expect(line(2).getByRole('radio', { name: 'Voz 2' })).toHaveAttribute('aria-checked', 'true');

  const axe = await new AxeBuilder({ page: ana.page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  expect(axe.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([]);
  await line(1).getByRole('radio', { name: 'Voz 2' }).click();
  await line(2).getByRole('radio', { name: 'Juntos' }).click();
  await expect(line(1).getByRole('radio', { name: 'Voz 1' })).toHaveAttribute('aria-checked', 'false');
  await dialog.getByRole('button', { name: 'Salvar a divisão' }).click();
  await expect(ana.page.getByText('Divisão da letra salva.')).toBeVisible();
  await expect.poll(async () => (await itemNow())?.parts).toBe('b*a');

  // the guest sees the button and the saved split too
  await bia.page.getByRole('button', { name: 'Dividir a letra' }).click();
  const biaDialog = bia.page.getByRole('dialog', { name: 'Quem canta cada linha' });
  await expect(biaDialog.getByRole('radiogroup', { name: 'Quem canta a linha 1' }).getByRole('radio', { name: 'Voz 2' })).toHaveAttribute('aria-checked', 'true');
  await biaDialog.getByRole('button', { name: 'Voltar ao automático' }).click();
  await expect(bia.page.getByText('Voltou à divisão automática.')).toBeVisible();
  await expect.poll(async () => (await itemNow())?.parts).toBeNull();
  for (const p of [ana, bia]) await p.context.close();
});

test("when the song comes up, the TV and the Stage paint the lines as the singers split them", async ({ browser, page: tv, request }) => {
  const { room, itemId, ana, bia } = await duetRoom(browser, request);
  await ana.page.getByRole('button', { name: 'Dividir a letra' }).click();
  const dialog = ana.page.getByRole('dialog', { name: 'Quem canta cada linha' });
  await dialog.getByRole('radiogroup', { name: 'Quem canta a linha 1' }).getByRole('radio', { name: 'Juntos' }).click();
  await dialog.getByRole('radiogroup', { name: 'Quem canta a linha 2' }).getByRole('radio', { name: 'Voz 1' }).click();
  await dialog.getByRole('button', { name: 'Salvar a divisão' }).click();
  await expect.poll(async () => (await roomState(request, room.code)).queue.find((i) => i.id === itemId)?.parts).toBe('*aa');

  await tv.goto(room.tvUrl);
  await expect.poll(() => tvPlaying(tv)).toBe(true);
  await request.post(`/api/rooms/${room.code}/player/skip`, { headers: { 'x-client-id': ANA, 'x-host-token': room.host } }); // the pair comes in
  await expect(ana.page).toHaveURL(/\/stage\.html/, { timeout: 10_000 });
  await expect(ana.page.locator('.line.current')).toContainText('Primeira linha da letra');
  await expect(ana.page.locator('.line.current')).toHaveAttribute('data-part', 'both'); // line 1: together
  await expect(ana.page.locator('.line.next')).toHaveAttribute('data-part', 'a'); // line 2: voice 1
  await expect(tv.locator('.line.current')).toHaveAttribute('data-part', 'both'); // and the TV paints it the same
  for (const p of [ana, bia]) await p.context.close();
});

test("whoever does not sing the song does not see the button to split the lyrics", async ({ browser, request }) => {
  const { room, ana, bia } = await duetRoom(browser, request);
  const caio = await phone(browser, CAIO, 'Caio');
  await caio.page.goto(room.guestUrl);
  await expect(caio.page.getByText('Wicked Game').first()).toBeVisible();
  await expect(caio.page.getByRole('button', { name: 'Dividir a letra' })).toHaveCount(0);
  for (const p of [ana, bia, caio]) await p.context.close();
});

test("a Duet with two microphones: each singer is scored on their lines and the scoreboard shows each one's score", async ({ browser, page: tv, request }) => {
  test.setTimeout(90_000);
  const { room, ana, bia } = await duetRoom(browser, request);
  // the TV uses both microphones (the test Chromium's two "Fake Audio Input"): the 1st is voice 1, the 2nd is voice 2
  await tv.goto(room.tvUrl);
  await tv.evaluate(async () => {
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default');
    localStorage.setItem('voiceMics', JSON.stringify(devices.slice(0, 2).map((d) => ({ id: d.deviceId, label: d.label }))));
  });
  await request.patch(`/api/rooms/${room.code}`, { headers: { 'x-client-id': ANA, 'x-host-token': room.host }, data: { scoring: true } });
  await tv.reload();
  await expect.poll(() => tvPlaying(tv)).toBe(true);
  await request.post(`/api/rooms/${room.code}/player/skip`, { headers: { 'x-client-id': ANA, 'x-host-token': room.host } }); // the pair Ana & Bia comes in
  await expect(tv.locator('.singer.is-now')).toContainText('Ana & Bia');
  await expect(tv.locator('.score-hud')).toBeVisible();

  // the test lyrics have only 9 s of singing: with every line "together" both singers are held to them
  await request.put(`/api/rooms/${room.code}/songs/${SONGS.bravo.id}/parts`, { headers: { 'x-client-id': ANA, 'x-host-token': room.host }, data: { parts: '***' } });
  await expect.poll(() => tv.evaluate(() => window.tv.engine.currentTime), { timeout: 30_000 }).toBeGreaterThan(11.5); // the lines went by

  // near the song's end: time for both scores to count (the minimum is 5 s with a voice in the original, for each singer)
  await request.post(`/api/rooms/${room.code}/player/seek`, { headers: { 'x-client-id': ANA, 'x-host-token': room.host }, data: { seconds: 20 } });
  await expect(tv.locator('.score-final')).toBeVisible({ timeout: 40_000 });
  await expect(tv.locator('.score-final')).toContainText('Ana'); // "Ana 80 · Bia 70": each one's score
  await expect(tv.locator('.score-final')).toContainText('Bia');
  await expect(tv.locator('.score-final strong')).toHaveText(/^\d+$/);
  await expect.poll(async () => (await roomState(request, room.code)).scoreboard.length).toBe(1); // the song's score is a single one, the average
  for (const p of [ana, bia]) await p.context.close();
});

test("the melody guide in a Duet: the bars take the singer's color (turquoise and violet, like the lyrics)", async ({ browser, page: tv, request }) => {
  const { room, ana, bia } = await duetRoom(browser, request);
  await request.patch(`/api/rooms/${room.code}`, { headers: { 'x-client-id': ANA, 'x-host-token': room.host }, data: { melody_bars: true } });
  await tv.goto(room.tvUrl);
  await expect.poll(() => tvPlaying(tv)).toBe(true);
  await request.post(`/api/rooms/${room.code}/player/skip`, { headers: { 'x-client-id': ANA, 'x-host-token': room.host } }); // the pair comes in
  await expect(tv.locator('canvas.pitch-guide')).toBeVisible();
  await expect.poll(() => tv.evaluate(() => window.tv.engine.currentTime), { timeout: 20_000 }).toBeGreaterThan(5.5); // Ana's lines (1–4 s) and Bia's (5–8 s) are in the window

  const colorsSeen = () =>
    tv.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('canvas.pitch-guide')!;
      const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
      const near = (r: number, g: number, b: number, [tr, tg, tb]: number[]) => Math.abs(r - tr) < 24 && Math.abs(g - tg) < 24 && Math.abs(b - tb) < 24;
      let turquoise = 0;
      let violet = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i + 3] < 200) continue;
        if (near(data[i], data[i + 1], data[i + 2], [16, 184, 200])) turquoise++;
        if (near(data[i], data[i + 1], data[i + 2], [139, 92, 246])) violet++;
      }
      return { turquoise, violet };
    });
  await expect.poll(async () => (await colorsSeen()).turquoise, { timeout: 10_000 }).toBeGreaterThan(200); // Ana's part
  await expect.poll(async () => (await colorsSeen()).violet, { timeout: 10_000 }).toBeGreaterThan(200); // Bia's part
  for (const p of [ana, bia]) await p.context.close();
});

test("the melody guide outside a Duet: the bars keep the theme's color (no turquoise nor violet)", async ({ page, request }) => {
  const room = await createRoom(request);
  await addToQueue(request, room.code, SONGS.alpha, { client: ANA, name: 'Ana' });
  await request.patch(`/api/rooms/${room.code}`, { headers: { 'x-client-id': ANA, 'x-host-token': room.host }, data: { melody_bars: true } });
  await page.goto(room.tvUrl);
  await expect.poll(() => tvPlaying(page)).toBe(true);
  await expect(page.locator('canvas.pitch-guide')).toBeVisible();
  await page.waitForTimeout(800);
  const seen = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('canvas.pitch-guide')!;
    const data = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
    let violet = 0;
    for (let i = 0; i < data.length; i += 4) if (data[i + 3] > 200 && Math.abs(data[i] - 139) < 20 && Math.abs(data[i + 1] - 92) < 20 && Math.abs(data[i + 2] - 246) < 20) violet++;
    return violet;
  });
  expect(seen).toBe(0);
});
