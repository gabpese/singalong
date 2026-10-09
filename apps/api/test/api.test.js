import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { buildApp } from '../src/app.js';
import { createMemoryJobStore } from '../src/jobs.js';
import { LocalStorage } from '../src/storage.js';
import { extractVideoId } from '../src/youtube.js';

const VID = 'dQw4w9WgXcQ';
const READY = 'abcdefghijk';
let root;
let jobs;
let app;

async function seed(id, { complete = true } = {}) {
  const dir = join(root, 'cache', id);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'instrumental.mp3'), Buffer.from('0123456789'));
  if (!complete) return;
  await writeFile(join(dir, 'lyrics.json'), '[]');
  await writeFile(join(dir, 'meta.json'), JSON.stringify({ video_id: id, title: 'T', artist: 'A' }));
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'singalong-api-'));
  const publicDir = join(root, 'public');
  await mkdir(publicDir);
  await writeFile(join(publicDir, 'index.html'), '<title>Singalong</title>');
  await seed(READY);
  await seed('parcial0000', { complete: false });
  jobs = createMemoryJobStore();
  app = buildApp({ config: { publicDir }, storage: new LocalStorage(root), jobs });
  await app.ready();
});

after(() => app.close());

const post = (payload) => app.inject({ method: 'POST', url: '/api/songs', payload });

test('extractVideoId', () => {
  for (const url of [`https://www.youtube.com/watch?v=${VID}&t=1`, `https://youtu.be/${VID}?si=x`, `https://music.youtube.com/watch?v=${VID}`, `https://www.youtube.com/shorts/${VID}`, VID]) {
    assert.equal(extractVideoId(url), VID, url);
  }
  for (const url of ['', `https://example.com/watch?v=${VID}`, 'https://youtu.be/curto', 'lixo', undefined]) {
    assert.equal(extractVideoId(url), null, String(url));
  }
});

test('health e readiness', async () => {
  assert.equal((await app.inject('/healthz')).statusCode, 200);
  assert.equal((await app.inject('/readyz')).statusCode, 200);
});

test('POST: link inválido e corpo inválido', async () => {
  assert.equal((await post({ url: 'https://example.com/x' })).statusCode, 400);
  assert.equal((await post({})).statusCode, 400);
  assert.equal((await post({ url: VID, lyrics: { source: 'ia' } })).statusCode, 400);
  assert.equal((await post({ url: VID, lyrics: { source: 'text' } })).statusCode, 400); // texto obrigatório
});

test('POST: música inédita cria job; repetir faz dedupe (um único job na fila)', async () => {
  const first = await post({ url: `https://youtu.be/${VID}` });
  assert.equal(first.statusCode, 202);
  assert.equal(first.json().status, 'pending');
  assert.equal(first.json().deduped, false);

  const again = await post({ url: `https://www.youtube.com/watch?v=${VID}` });
  assert.equal(again.statusCode, 200);
  assert.equal(again.json().deduped, true);
  assert.equal(jobs.queue.filter((j) => j.video_id === VID).length, 1);
  // o worker recebe sempre a URL canônica
  assert.equal(jobs.queue.find((j) => j.video_id === VID).payload.url, `https://www.youtube.com/watch?v=${VID}`);
});

test('POST: música em cache responde pronta, sem criar job', async () => {
  const queued = jobs.queue.length;
  const res = await post({ url: READY });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'ready');
  assert.equal(res.json().cached, true);
  assert.equal(res.json().media.instrumental, `/media/cache/${READY}/instrumental.mp3`);
  assert.equal(jobs.queue.length, queued);
});

test('pasta parcial não conta como pronta', async () => {
  assert.equal((await app.inject('/api/songs/parcial0000')).statusCode, 404);
  const ids = (await app.inject('/api/songs')).json().map((s) => s.video_id);
  assert.deepEqual(ids, [READY]);
});

test('fluxo needs_lyrics -> PUT letra', async () => {
  const id = 'needsLyrics';
  await post({ url: id });
  const busy = await app.inject({ method: 'PUT', url: `/api/songs/${id}/lyrics`, payload: { source: 'lrclib' } });
  assert.equal(busy.statusCode, 409); // ainda pending

  jobs.update(id, { status: 'needs_lyrics', error: 'sem legenda no vídeo' });
  const status = (await app.inject(`/api/songs/${id}`)).json();
  assert.equal(status.status, 'needs_lyrics');
  assert.equal(status.error, 'sem legenda no vídeo');

  // POST de novo não reenfileira enquanto espera a escolha da letra
  assert.equal((await post({ url: id })).json().deduped, true);

  const put = await app.inject({ method: 'PUT', url: `/api/songs/${id}/lyrics`, payload: { source: 'text', text: 'a\nb' } });
  assert.equal(put.statusCode, 202);
  const queued = jobs.queue.at(-1);
  assert.equal(queued.video_id, id);
  assert.deepEqual([queued.payload.lyrics_source, queued.payload.lyrics_text], ['text', 'a\nb']);
});

test('letra: "sem letra" e "aceitar duração diferente" chegam ao worker', async () => {
  const id = 'semLetra001';
  assert.equal((await post({ url: id, lyrics: { source: 'none' } })).statusCode, 202); // sem texto: válido
  assert.equal(jobs.queue.at(-1).payload.lyrics_source, 'none');
  const other = 'looseLetra1';
  await post({ url: other, lyrics: { source: 'lrclib', loose: true }, artist: 'A', title: 'B' });
  assert.equal(jobs.queue.at(-1).payload.lyrics_loose, true);
});

test('letra: alinhamento por IA exige o texto e chega ao worker', async () => {
  const id = 'alinhar0001';
  assert.equal((await post({ url: id, lyrics: { source: 'align' } })).statusCode, 400); // sem texto
  assert.equal((await post({ url: id, lyrics: { source: 'align', text: 'a\nb' } })).statusCode, 202);
  const { payload } = jobs.queue.at(-1);
  assert.deepEqual([payload.lyrics_source, payload.lyrics_text], ['align', 'a\nb']);
});

test('GET /api/search: valida a consulta, devolve miniaturas e trata falhas', async () => {
  assert.equal((await app.inject('/api/search')).statusCode, 400);
  assert.equal((await app.inject('/api/search?q=a')).statusCode, 400); // curta demais
  jobs.searchResults = [{ video_id: 'TLvtw4nXou0', title: "Jack's Lament", channel: 'Geoff', duration: 265 }];
  const ok = await app.inject('/api/search?q=jack%27s%20lament');
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(ok.json(), [{ ...jobs.searchResults[0], thumbnail: 'https://i.ytimg.com/vi/TLvtw4nXou0/mqdefault.jpg' }]);
  assert.equal(jobs.searchQueries.at(-1), "jack's lament");
  jobs.searchResults = new Error('search_timeout');
  const down = await app.inject('/api/search?q=qualquer');
  assert.equal(down.statusCode, 503);
  assert.match(down.json().message, /cole o link/);
  jobs.searchResults = [];
});

test('PUT letra repassa artista e título ao worker', async () => {
  const id = 'artistaTit1';
  await post({ url: id });
  jobs.update(id, { status: 'needs_lyrics' });
  const put = await app.inject({ method: 'PUT', url: `/api/songs/${id}/lyrics`, payload: { source: 'lrclib', artist: 'Faouzia', title: 'Unethical' } });
  assert.equal(put.statusCode, 202);
  const { payload } = jobs.queue.at(-1);
  assert.deepEqual([payload.lyrics_source, payload.artist, payload.title], ['lrclib', 'Faouzia', 'Unethical']);
});

test('PUT letra: 404 para música desconhecida, 400 sem texto e id inválido', async () => {
  assert.equal((await app.inject({ method: 'PUT', url: '/api/songs/zzzzzzzzzzz/lyrics', payload: { source: 'lrclib' } })).statusCode, 404);
  assert.equal((await app.inject({ method: 'PUT', url: `/api/songs/${READY}/lyrics`, payload: { source: 'file' } })).statusCode, 400);
  assert.equal((await app.inject('/api/songs/curto')).statusCode, 400);
});

test('trocar a letra de uma música pronta reaproveita o cache e reflete o job ativo', async () => {
  const res = await app.inject({ method: 'PUT', url: `/api/songs/${READY}/lyrics`, payload: { source: 'lrclib' } });
  assert.equal(res.statusCode, 202);
  assert.equal(res.json().status, 'pending'); // job ativo tem prioridade
  assert.ok(res.json().meta); // mas o resultado anterior continua disponível
  jobs.update(READY, { status: 'ready' });
  assert.equal((await app.inject(`/api/songs/${READY}`)).json().status, 'ready');
});

test('failed pode ser reenfileirado por um novo POST', async () => {
  const id = 'falhou00000';
  await post({ url: id });
  jobs.update(id, { status: 'failed', error: 'boom' });
  const retry = await post({ url: id });
  assert.equal(retry.statusCode, 202);
  assert.equal(retry.json().status, 'pending');
});

test('media: Range, 404 e path traversal', async () => {
  const url = `/media/cache/${READY}/instrumental.mp3`;
  const ranged = await app.inject({ url, headers: { range: 'bytes=2-4' } });
  assert.equal(ranged.statusCode, 206);
  assert.equal(ranged.headers['content-range'], 'bytes 2-4/10');
  assert.equal(ranged.body, '234');
  assert.equal((await app.inject({ url, headers: { range: 'bytes=50-60' } })).statusCode, 416);
  assert.equal((await app.inject(url)).headers['accept-ranges'], 'bytes');
  assert.equal((await app.inject('/media/cache/nada/x.mp3')).statusCode, 404);
  for (const path of ['/media/../src/app.js', '/media/%2e%2e/src/app.js', '/media/cache/%2e%2e/%2e%2e/src/app.js']) {
    const { statusCode } = await app.inject(path);
    assert.ok([400, 403, 404].includes(statusCode), `${path} -> ${statusCode}`);
  }
});

test('serve o player e 404 JSON para /api desconhecida', async () => {
  const home = await app.inject('/');
  assert.equal(home.statusCode, 200);
  assert.match(home.body, /Singalong/);
  assert.equal((await app.inject('/api/nada')).statusCode, 404);
  assert.ok((await app.inject('/%2e%2e/src/app.js')).statusCode >= 400);
});
