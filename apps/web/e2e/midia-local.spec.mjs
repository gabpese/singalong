// Armazenamento local: a música está no computador do dono. A nuvem só conhece o catálogo que o agente publica; a TV busca o
// áudio e a letra no servidor local de mídia (outra origem, com CORS e Range), como o app do dono faria.
import { expect, test } from '@playwright/test';
import { ANA, publishLocalSong, startAgentSession } from './helpers.mjs';

const MEDIA_BASE = 'http://127.0.0.1:3101/e2e';
// uma música que a nuvem NÃO tem no armazenamento dela como "pronta" para esta sala: só o catálogo do dono a conhece
const LOCAL = { id: 'localSong01', title: 'Tempo Perdido', artist: 'Legião Urbana' };

async function seedOnOwnersComputer(request, song) {
  // "grava os arquivos" na pasta que o servidor local de mídia serve (no teste, a mesma pasta de testes)
  await request.post('/__test/seed-song', { data: song });
}

const playing = (page) => page.evaluate(() => window.tv.engine.playing && window.tv.engine.duration > 0 && window.tv.engine.currentTime > 0);

test.beforeEach(async ({ request }) => {
  await request.delete('/__test/media-log');
});

test.afterEach(async ({ request }) => {
  await request.post('/__test/remove-song', { data: { id: LOCAL.id } });
});

test('a TV toca a música que está no computador do dono, buscando-a no servidor local de mídia', async ({ page, request }) => {
  await seedOnOwnersComputer(request, LOCAL);
  const { headers, room, tvUrl } = await startAgentSession(request, 'Dona Flor', MEDIA_BASE);
  await publishLocalSong(request, headers, LOCAL);
  const added = await request.post(`/api/rooms/${room.code}/queue`, { headers: { 'x-client-id': ANA }, data: { video_id: LOCAL.id, name: 'Ana' } });
  expect(added.status(), await added.text()).toBe(201);

  // a sala descreve a música pelos endereços do servidor local, e avisa que a mídia é local
  const state = await (await request.get(`/api/rooms/${room.code}`, { headers: { 'x-client-id': ANA } })).json();
  expect(state.local_media).toBe(true);
  expect(state.queue[0].song.media).toMatchObject({ instrumental: `${MEDIA_BASE}/cache/${LOCAL.id}/instrumental.mp3`, local: true });

  await page.goto(tvUrl);
  await expect(page.locator('.singer.is-now')).toContainText('Ana');
  await expect.poll(() => playing(page)).toBe(true);
  await expect(page.locator('.line.current')).toContainText('Primeira linha da letra');
  await expect(page.getByRole('alert')).toBeHidden(); // tudo certo: nenhum aviso

  // o áudio, a letra e a sonda vieram do servidor local, de outra origem (com CORS), e não do servidor da sala
  const log = await (await request.get('/__test/media-log')).json();
  const urls = log.map((entry) => entry.url);
  expect(urls).toContain('/e2e/ping');
  expect(urls).toContain(`/e2e/cache/${LOCAL.id}/instrumental.mp3`);
  expect(urls).toContain(`/e2e/cache/${LOCAL.id}/lyrics.json`);
  expect(log.find((entry) => entry.url.endsWith('instrumental.mp3')).origin).toBe('http://127.0.0.1:3100');
});

test('o celular não oferece a prévia do instrumental de uma música que está no computador do dono', async ({ page, request }) => {
  await seedOnOwnersComputer(request, LOCAL);
  const { headers, room, guestUrl } = await startAgentSession(request, 'Seu Zé', MEDIA_BASE);
  await publishLocalSong(request, headers, LOCAL);
  await request.post(`/api/rooms/${room.code}/queue`, { headers: { 'x-client-id': ANA }, data: { video_id: LOCAL.id, name: 'Ana' } });

  await page.goto(guestUrl);
  await expect(page.getByText('Tempo Perdido').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Prévia' })).toHaveCount(0);
});

test('se o navegador não alcança o servidor local de mídia, a TV explica o que fazer', async ({ page, request }) => {
  await seedOnOwnersComputer(request, LOCAL);
  const { headers, room, tvUrl } = await startAgentSession(request, 'Dona Flor', 'http://127.0.0.1:3199/e2e'); // ninguém escuta nessa porta
  await publishLocalSong(request, headers, LOCAL);
  await request.post(`/api/rooms/${room.code}/queue`, { headers: { 'x-client-id': ANA }, data: { video_id: LOCAL.id, name: 'Ana' } });

  await page.goto(tvUrl);
  await expect(page.getByRole('alert')).toContainText('O navegador bloqueou o acesso às músicas deste computador');
  await expect(page.getByRole('alert')).toContainText('rede local');
});

test('sem música local na sala a TV não verifica nem avisa nada', async ({ page, request }) => {
  const { room, tvUrl } = await startAgentSession(request, 'Dona Flor', MEDIA_BASE);
  expect((await (await request.get(`/api/rooms/${room.code}`, { headers: { 'x-client-id': ANA } })).json()).local_media).toBe(true); // a sessão é local...
  await page.goto(tvUrl);
  await expect(page.getByText(`Entre na sala ${room.code} pelo celular`)).toBeVisible();
  await expect(page.getByRole('alert')).toBeHidden();
  const log = await (await request.get('/__test/media-log')).json();
  expect(log.filter((entry) => entry.url === '/e2e/ping')).toHaveLength(0); // ...mas sem música local ainda não há o que verificar
});
