// Servidor dos testes de ponta a ponta: a API de verdade (rotas, salas, WebSocket) com fila de jobs em memória, um
// storage temporário com músicas prontas e o front-end de `E2E_PUBLIC` (a pasta `dist` do build; padrão: `dist`).
// Rotas /__test/* só existem aqui: deixam o teste fingir o worker (resultados de busca, andamento de jobs).
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../../api/src/app.js';
import { createMemoryJobStore } from '../../api/src/jobs.js';
import { LocalStorage } from '../../api/src/storage.js';

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
const app = buildApp({ config: { publicDir, publicUrl: '', adminToken: 'e2e-admin', rateLimits: { search: BIG, addToQueue: BIG, createRoom: BIG, pair: BIG } }, storage: new LocalStorage(root), jobs });

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
  app.db.touchSession(request.body.id, Date.now() - 3_600_000);
  return { ok: true };
});
app.get('/__test/state', async () => ({ queue: jobs.queue, exportQueue: jobs.exportQueue, searchQueries: jobs.searchQueries }));

app.rooms.start({ tickMs: 300 });
await app.listen({ port: PORT, host: '127.0.0.1' });
console.log(`e2e em http://127.0.0.1:${PORT} (front-end: ${publicDir})`);
