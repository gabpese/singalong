// Nível das vozes de apoio: o controle no celular (de quem escolheu a música) e a TV tocando o apoio junto do instrumental.
import { expect, test } from '@playwright/test';
import { addToQueue, ANA, BIA, createRoom, roomState, SONGS } from './helpers.mjs';

const slider = (page) => page.getByRole('slider', { name: 'Nível das vozes de apoio' });
const itemOf = async (request, room, song) => (await roomState(request, room.code)).queue.find((i) => i.video_id === song.id);
const setBacking = (request, room, itemId, level, client = ANA) =>
  request.patch(`/api/rooms/${room.code}/queue/${itemId}`, { headers: { 'x-client-id': client }, data: { backing: level } });
const engine = (page) => page.evaluate(() => ({
  level: window.tv.engine.backingLevel,
  has: window.tv.engine.hasBacking,
  playing: window.tv.engine.backingPlaying,
  drift: Math.abs(window.tv.engine.backingTime - window.tv.engine.currentTime),
  main: window.tv.engine.currentTime,
}));

test.describe('celular', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('a barra só aparece nas músicas que têm vozes de apoio, para quem as escolheu', async ({ page, request }) => {
    const room = await createRoom(request);
    await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' }); // tem apoio
    await addToQueue(request, room.code, SONGS.charlie, { name: 'Ana' }); // não tem
    await page.addInitScript((id) => localStorage.setItem('clientId', id), ANA);
    await page.goto(room.guestUrl);
    await expect(page.locator('.now').getByRole('slider', { name: 'Nível das vozes de apoio' })).toBeVisible();
    await expect(page.locator('.queue-item', { hasText: 'Rolling in the Deep' }).getByRole('slider', { name: 'Nível das vozes de apoio' })).toHaveCount(0);
  });

  test('arrastar a barra manda o nível da música para a sala', async ({ page, request }) => {
    const room = await createRoom(request);
    const id = await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' });
    await page.addInitScript((c) => localStorage.setItem('clientId', c), ANA);
    await page.goto(room.guestUrl);
    await expect(slider(page)).toHaveValue('0'); // padrão: desligado
    await slider(page).fill('40');
    await expect(page.locator('.now .backing-value')).toHaveText('40%');
    await expect.poll(async () => (await itemOf(request, room, SONGS.alpha)).backing).toBe(40);
    expect(id).toBeTruthy();
    // a barra segue o que a sala diz (mudança vinda de outro lugar)
    await setBacking(request, room, id, 75);
    await expect(slider(page)).toHaveValue('75');
  });

  test('quem não escolheu a música só vê o valor, sem poder mexer', async ({ page, request }) => {
    const room = await createRoom(request);
    const id = await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' });
    await setBacking(request, room, id, 60);
    await page.addInitScript((c) => localStorage.setItem('clientId', c), BIA); // outra pessoa
    await page.goto(room.guestUrl);
    await expect(page.getByText('Vozes de apoio 60%')).toBeVisible();
    await expect(slider(page)).toHaveCount(0);
  });

  test('o anfitrião muda o nível de qualquer música, também na fila', async ({ page, request }) => {
    const room = await createRoom(request);
    await addToQueue(request, room.code, SONGS.charlie, { name: 'Ana' });
    await addToQueue(request, room.code, SONGS.bravo, { client: BIA, name: 'Bia' }); // é da Bia, na fila
    await page.goto(room.hostUrl);
    const row = page.locator('.queue-item', { hasText: 'Unethical' });
    await row.getByRole('slider', { name: 'Nível das vozes de apoio' }).fill('25');
    await expect.poll(async () => (await itemOf(request, room, SONGS.bravo)).backing).toBe(25);
  });
});

test.describe('TV', () => {
  const play = async (page, request, level) => {
    const room = await createRoom(request);
    const id = await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' });
    if (level) await setBacking(request, room, id, level);
    await page.goto(room.tvUrl);
    await expect.poll(() => page.evaluate(() => window.tv.engine.playing && window.tv.engine.currentTime > 0.3)).toBe(true);
    return { room, id };
  };

  test('com o nível em 0 as vozes de apoio não tocam (nem são baixadas)', async ({ page, request }) => {
    await play(page, request, 0);
    const state = await engine(page);
    expect(state).toMatchObject({ level: 0, has: true, playing: false });
  });

  test('com o nível acima de 0 o apoio toca junto, no mesmo ponto do instrumental', async ({ page, request }) => {
    await play(page, request, 60);
    await expect.poll(async () => (await engine(page)).playing).toBe(true);
    const state = await engine(page);
    expect(state.level).toBe(60);
    expect(state.drift).toBeLessThan(0.3);
  });

  test('mudar o nível no meio da música liga e desliga o apoio, já no ponto certo', async ({ page, request }) => {
    const { room, id } = await play(page, request, 0);
    await setBacking(request, room, id, 80);
    await expect.poll(async () => (await engine(page)).playing).toBe(true);
    await expect.poll(async () => (await engine(page)).drift).toBeLessThan(0.3);
    await setBacking(request, room, id, 0);
    await expect.poll(async () => (await engine(page)).playing).toBe(false);
    await setBacking(request, room, id, 30);
    await expect.poll(async () => (await engine(page)).playing).toBe(true);
    await expect.poll(async () => (await engine(page)).drift).toBeLessThan(0.3);
  });

  test('pausar, retomar e pular a posição acompanham o apoio', async ({ page, request }) => {
    const { room } = await play(page, request, 70);
    await expect.poll(async () => (await engine(page)).playing).toBe(true);
    const host = { 'x-client-id': ANA, 'x-host-token': room.host };
    await request.post(`/api/rooms/${room.code}/player/pause`, { headers: host });
    await expect.poll(async () => (await engine(page)).playing).toBe(false);
    await request.post(`/api/rooms/${room.code}/player/resume`, { headers: host });
    await expect.poll(async () => (await engine(page)).playing).toBe(true);
    await request.post(`/api/rooms/${room.code}/player/seek`, { headers: host, data: { to: 20 } });
    await expect.poll(async () => (await engine(page)).main).toBeGreaterThan(19.5);
    await expect.poll(async () => (await engine(page)).drift).toBeLessThan(0.3);
  });

  test('música sem vozes de apoio: nada a tocar mesmo com nível definido', async ({ page, request }) => {
    const room = await createRoom(request);
    const id = await addToQueue(request, room.code, SONGS.charlie, { name: 'Ana' });
    await setBacking(request, room, id, 90);
    await page.goto(room.tvUrl);
    await expect.poll(() => page.evaluate(() => window.tv.engine.playing && window.tv.engine.currentTime > 0.3)).toBe(true);
    expect(await engine(page)).toMatchObject({ has: false, playing: false });
  });

  test('ao passar para a próxima música o apoio da anterior para', async ({ page, request }) => {
    const { room } = await play(page, request, 70);
    await addToQueue(request, room.code, SONGS.charlie, { client: BIA, name: 'Bia' }); // sem apoio
    await expect.poll(async () => (await engine(page)).playing).toBe(true);
    await request.post(`/api/rooms/${room.code}/player/skip`, { headers: { 'x-client-id': ANA, 'x-host-token': room.host } });
    await expect(page.locator('.singer.is-now')).toContainText('Rolling in the Deep');
    await expect.poll(async () => (await engine(page)).playing).toBe(false);
  });
});

// --- o SOM, não só o estado: mede o que sai pelo destino do áudio (a faixa de apoio é um tom de 440 Hz; o instrumental, de 220 Hz) ---
test.describe('som de saída', () => {
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
      const connect = AudioNode.prototype.connect;
      AudioNode.prototype.connect = function (dest, ...rest) {
        if (dest instanceof AudioDestinationNode) {
          window.__analyser ??= Object.assign(dest.context.createAnalyser(), { fftSize: 2048 });
          connect.call(this, window.__analyser); // escuta em paralelo, sem alterar o caminho do som
        }
        return connect.call(this, dest, ...rest);
      };
      window.__rms = () => {
        const analyser = window.__analyser;
        if (!analyser) return 0;
        const buffer = new Float32Array(analyser.fftSize);
        let sum = 0;
        let count = 0;
        for (let i = 0; i < 12; i++) {
          analyser.getFloatTimeDomainData(buffer);
          for (const v of buffer) { sum += v * v; count++; }
        }
        return Math.sqrt(sum / count);
      };
    });
  });

  const loudness = async (page) => {
    await page.waitForTimeout(1500); // o grafo estabiliza depois da mudança de nível
    const samples = [];
    for (let i = 0; i < 8; i++) {
      samples.push(await page.evaluate(() => window.__rms()));
      await page.waitForTimeout(120);
    }
    return Math.sqrt(samples.reduce((sum, v) => sum + v * v, 0) / samples.length);
  };

  test('o apoio realmente soma ao som: 0% = só o instrumental, 100% = os dois (+3 dB), 50% no meio', async ({ page, request }) => {
    const room = await createRoom(request);
    const id = await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' });
    await page.goto(room.tvUrl);
    await expect.poll(() => page.evaluate(() => window.tv.engine.playing && window.tv.engine.currentTime > 0.5)).toBe(true);

    const off = await loudness(page);
    expect(off).toBeGreaterThan(0.05); // o instrumental está soando
    await setBacking(request, room, id, 100);
    await expect.poll(async () => (await engine(page)).playing).toBe(true);
    const full = await loudness(page);
    await setBacking(request, room, id, 50);
    const half = await loudness(page);
    await setBacking(request, room, id, 0);
    const offAgain = await loudness(page);

    // dois tons de mesma força somam em potência: 100% = raiz de 2 vezes o volume (+3 dB); 50% = raiz de 1,25
    expect(full / off).toBeGreaterThan(1.3);
    expect(full / off).toBeLessThan(1.55);
    expect(half / off).toBeGreaterThan(1.05);
    expect(half / off).toBeLessThan(1.2);
    expect(offAgain / off).toBeGreaterThan(0.9);
    expect(offAgain / off).toBeLessThan(1.1);
  });

  test('o apoio soa também quando o nível já vem ligado ao carregar a música', async ({ page, request }) => {
    const room = await createRoom(request);
    const id = await addToQueue(request, room.code, SONGS.alpha, { name: 'Ana' });
    await setBacking(request, room, id, 100); // antes de a TV abrir
    await page.goto(room.tvUrl);
    await expect.poll(async () => (await engine(page)).playing).toBe(true);
    const withBacking = await loudness(page);
    await setBacking(request, room, id, 0);
    const without = await loudness(page);
    expect(withBacking / without).toBeGreaterThan(1.3);
  });
});
