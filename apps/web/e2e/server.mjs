// Servidor dos testes de ponta a ponta: a API de verdade (rotas, salas, WebSocket) com fila de jobs em memória, um
// storage temporário com músicas prontas e o front-end de `E2E_PUBLIC` (a pasta `dist` do build; padrão: `dist`).
// Rotas /__test/* só existem aqui: deixam o teste fingir o worker (resultados de busca, andamento de jobs).
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
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
  { id: 'songAlpha01', title: 'Wicked Game', artist: 'Stone Sour', tonic: 3 },
  { id: 'songBravo02', title: 'Unethical', artist: 'Faouzia', tonic: 9 },
  { id: 'songCharl03', title: 'Rolling in the Deep', artist: 'Adele', tonic: 0 },
  { id: 'songDelta04', title: 'Unethical (Acoustic)', artist: 'Faouzia', tonic: 7 },
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
    await writeFile(join(dir, 'lyrics.json'), JSON.stringify(LYRICS));
    await writeFile(join(dir, 'melody.json'), JSON.stringify(MELODY));
    await writeFile(
      join(dir, 'meta.json'),
      JSON.stringify({
        video_id: song.id, title: song.title, artist: song.artist, duration: 30, lyrics_source: 'lrclib',
        key: { tonic: song.tonic, mode: 'major', name: 'X', score: 0.9, margin: 0.2 },
      }),
    );
  }
}

const root = await mkdtemp(join(tmpdir(), 'singalong-e2e-'));
await seed(root);
const jobs = createMemoryJobStore();
const app = buildApp({ config: { publicDir, publicUrl: '', rateLimits: { search: { max: 1e6, windowMs: 60_000 }, addToQueue: { max: 1e6, windowMs: 60_000 }, createRoom: { max: 1e6, windowMs: 60_000 } } }, storage: new LocalStorage(root), jobs });

app.post('/__test/search-results', async (request) => {
  jobs.searchResults = request.body;
  return { ok: true };
});
app.get('/__test/state', async () => ({ queue: jobs.queue, exportQueue: jobs.exportQueue }));

app.rooms.start({ tickMs: 300 });
await app.listen({ port: PORT, host: '127.0.0.1' });
console.log(`e2e em http://127.0.0.1:${PORT} (front-end: ${publicDir})`);
