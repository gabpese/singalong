// Servidor dos testes de ponta a ponta: a API de verdade (rotas, salas, WebSocket) com fila de jobs em memória, um
// storage temporário com músicas prontas e o front-end de `E2E_PUBLIC` (a pasta `dist` do build; padrão: `dist`).
// Rotas /__test/* só existem aqui: deixam o teste fingir o worker (resultados de busca, andamento de jobs).
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../../api/dist/app.js';
import { Session } from '../../api/dist/database/entities.js';
import { createMemoryJobStore } from '../../api/dist/jobs.js';
import { LocalStorage } from '../../api/dist/storage.js';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.E2E_PORT ?? 3100);
const publicDir = resolve(here, '..', process.env.E2E_PUBLIC ?? 'dist');

/** Músicas prontas: o id (11 caracteres), o título, o artista e uma letra curta com o tempo de cada palavra. */
export const SONGS = [
  { id: 'songAlpha01', title: 'Wicked Game', artist: 'Stone Sour', tonic: 3, videoTitle: 'Stone Sour - Wicked Game Lyrics', backing: true },
  { id: 'songBravo02', title: 'Unethical', artist: 'Faouzia', tonic: 9, videoTitle: 'Faouzia - UNETHICAL (Official Music Video)', backing: true },
  { id: 'songCharl03', title: 'Rolling in the Deep', artist: 'Adele', tonic: 0, videoTitle: 'Adele - Rolling in the Deep (Official Music Video)' },
  // pedida como Faouzia + "Unethical (Acoustic)", mas o vídeo se chama "... (MAPHRA Vocal Cover)"
  { id: 'songDelta04', title: 'Unethical (Acoustic)', artist: 'Faouzia', tonic: 7, videoTitle: 'Faouzia - Unethical (MAPHRA Vocal Cover)' },
];

const LYRICS = [
  { start: 1.0, end: 4.0, text: 'Primeira linha da letra', words: [[1.0, 1.6], [1.6, 2.2], [2.2, 2.6], [2.6, 3.2], [3.2, 4.0]] },
  { start: 5.0, end: 8.0, text: 'Segunda linha cantada agora', words: [[5.0, 5.6], [5.6, 6.2], [6.2, 6.8], [6.8, 7.4], [7.4, 8.0]] },
  { start: 9.0, end: 12.0, text: 'Terceira e última linha', words: [[9.0, 9.8], [9.8, 10.2], [10.2, 11.0], [11.0, 12.0]] },
];

// melodia estável de 30 s (uma nota por 2 s, em quadros de 50 ms), para a pontuação ter com o que comparar
const MELODY = { hop: 0.05, midi: Array.from({ length: 600 }, (_, i) => [57, 60, 64, 62, 59][Math.floor(i / 40) % 5]) };

async function seed(root) {
  for (const song of SONGS) {
    const dir = join(root, 'cache', song.id);
    await mkdir(dir, { recursive: true });
    await copyFile(join(here, 'fixtures', 'tone.mp3'), join(dir, 'instrumental.mp3'));
    if (song.backing) await copyFile(join(here, 'fixtures', 'tone-440.mp3'), join(dir, 'backing.mp3')); // só algumas músicas têm vozes de apoio (num tom diferente do instrumental: a soma dos dois fica mensurável)
    if (song.backing) await copyFile(join(here, 'fixtures', 'tone-440.mp3'), join(dir, 'vocals.mp3')); // a voz original (guia) existe nas mesmas músicas
    await writeFile(join(dir, 'lyrics.json'), JSON.stringify(LYRICS));
    await writeFile(join(dir, 'melody.json'), JSON.stringify(MELODY));
    await writeFile(
      join(dir, 'meta.json'),
      JSON.stringify({
        video_id: song.id, title: song.title, artist: song.artist, video_title: song.videoTitle, duration: 30, lyrics_source: 'lrclib',
        key: { tonic: song.tonic, mode: 'major', name: 'X', score: 0.9, margin: 0.2 },
      }),
    );
  }
}

// E2E_STORAGE: usa uma pasta de músicas de verdade (só leitura) em vez das de teste (diagnóstico com arquivos reais)
const root = process.env.E2E_STORAGE ? resolve(process.env.E2E_STORAGE) : await mkdtemp(join(tmpdir(), 'singalong-e2e-'));
if (!process.env.E2E_STORAGE) await seed(root);
const jobs = createMemoryJobStore();
const BIG = { max: 1e6, windowMs: 60_000 };
// adminToken liga o pareamento do agente local (/agent/v1): os testes de agente.spec.mjs fazem o papel do app do dono
// intervalo entre músicas: as salas dos testes nascem com ele desligado (os testes antigos esperam a próxima música na hora); os
// testes do intervalo o ligam e ele dura E2E_INTERMISSION_MS em cada fase (3 s, ou mais para ver as cenas inteiras)
const INTERMISSION_MS = Number(process.env.E2E_INTERMISSION_MS ?? 3000);
const app = await buildApp({
  config: {
    publicDir,
    publicUrl: '',
    adminPath: 'e2e-painel-secreto-0123456789',
    appDownloadUrl: 'https://example.test/releases/latest',
    appLatestVersion: '1.2.3',
    adminToken: 'e2e-admin',
    rateLimits: { search: BIG, addToQueue: BIG, createRoom: BIG, pair: BIG },
    intermissionApplauseMs: INTERMISSION_MS,
    intermissionStageMs: INTERMISSION_MS,
    intermissionByDefault: false,
  },
  storage: new LocalStorage(root),
  jobs,
});

app.post('/__test/search-results', async (request) => {
  jobs.searchResults = request.body;
  return { ok: true };
});
// o agente falso "grava os arquivos" da música como o agente de verdade faria ao terminar o processamento
app.post('/__test/seed-song', async (request) => {
  const { id, title, artist } = request.body;
  const dir = join(root, 'cache', id);
  await mkdir(dir, { recursive: true });
  await copyFile(join(here, 'fixtures', 'tone.mp3'), join(dir, 'instrumental.mp3'));
  await writeFile(join(dir, 'lyrics.json'), JSON.stringify(LYRICS));
  await writeFile(join(dir, 'meta.json'), JSON.stringify({ video_id: id, title, artist, duration: 30, lyrics_source: 'none' }));
  return { ok: true };
});
// apaga a música semeada: a biblioteca é compartilhada entre os testes e não pode ganhar músicas que eles não esperam
app.post('/__test/remove-song', async (request) => {
  await rm(join(root, 'cache', request.body.id), { recursive: true, force: true });
  return { ok: true };
});
// derruba o sinal de vida do dono da sessão (o app dele fechou sem avisar)
app.post('/__test/session-offline', async (request) => {
  await app.orm.em.fork().nativeUpdate(Session, { id: request.body.id, endedAt: null }, { lastSeen: Date.now() - 3_600_000 });
  return { ok: true };
});
app.get('/__test/state', async () => ({ queue: jobs.queue, exportQueue: jobs.exportQueue, searchQueries: jobs.searchQueries }));

// Servidor local de mídia do agente (o que o app do dono faz no computador dele): serve as músicas de `root/cache` em outra origem,
// com CORS e Range, como o media_server.py. Registra os pedidos para o teste conferir de onde a TV buscou o áudio.
const MEDIA_PORT = Number(process.env.E2E_MEDIA_PORT ?? 3101);
const mediaLog = [];
const mediaServer = createServer(async (req, res) => {
  const origin = req.headers.origin;
  mediaLog.push({ url: req.url, origin, range: req.headers.range ?? null });
  const cors = {
    ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
    'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length',
    'Access-Control-Allow-Headers': 'range',
  };
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
  const path = req.url.split('?')[0];
  if (path === '/e2e/ping') return res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }).end('{"ok":true}');
  const match = /^\/e2e\/cache\/([A-Za-z0-9_-]{11})\/(instrumental\.mp3|lyrics\.json|melody\.json|backing\.mp3|vocals\.mp3)$/.exec(path);
  const file = match && join(root, 'cache', match[1], match[2]);
  const info = file && (await stat(file).catch(() => null));
  if (!info) return res.writeHead(404, cors).end();
  const type = file.endsWith('.json') ? 'application/json' : 'audio/mpeg';
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
  if (range) {
    const start = Number(range[1] || 0);
    const end = Math.min(Number(range[2] || info.size - 1), info.size - 1);
    res.writeHead(206, { ...cors, 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Range': `bytes ${start}-${end}/${info.size}`, 'Content-Length': end - start + 1 });
    return createReadStream(file, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...cors, 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': info.size });
  return createReadStream(file).pipe(res);
});
await new Promise((resolve) => mediaServer.listen(MEDIA_PORT, '127.0.0.1', resolve));
app.get('/__test/media-log', async () => mediaLog);
app.delete('/__test/media-log', async () => { mediaLog.length = 0; return { ok: true }; });

app.rooms.start({ tickMs: 300 });
await app.listen({ port: PORT, host: '127.0.0.1' });
console.log(`e2e em http://127.0.0.1:${PORT} (front-end: ${publicDir})`);
