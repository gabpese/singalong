// The end-to-end tests' server: the real API (routes, Rooms, WebSocket) with an in-memory job queue, a temporary storage with
// ready songs, and the pages from `E2E_PUBLIC` (the build's `dist` folder; by default `dist`).
// The /__test/* routes exist only here: they let the test play the worker (search results, the jobs' progress).
import { createReadStream } from 'node:fs';
import { createServer } from 'node:http';
import { copyFile, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// The API's compiled dist/ carries no types (ROADMAP, step 6), so these come in untyped.
// @ts-expect-error untyped
import { buildApp } from '../../api/dist/app.js';
// @ts-expect-error untyped
import { Session } from '../../api/dist/database/entities.js';
// @ts-expect-error untyped
import { createMemoryJobStore } from '../../api/dist/jobs.js';
// @ts-expect-error untyped
import { LocalStorage } from '../../api/dist/storage.js';

const here = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.E2E_PORT ?? 3100);
const publicDir = resolve(here, '..', process.env.E2E_PUBLIC ?? 'dist');

/** The ready songs: the id (11 characters), the title, the artist and short lyrics with each word's time. */
export const SONGS = [
  { id: 'songAlpha01', title: 'Wicked Game', artist: 'Stone Sour', tonic: 3, videoTitle: 'Stone Sour - Wicked Game Lyrics', backing: true },
  { id: 'songBravo02', title: 'Unethical', artist: 'Faouzia', tonic: 9, videoTitle: 'Faouzia - UNETHICAL (Official Music Video)', backing: true },
  { id: 'songCharl03', title: 'Rolling in the Deep', artist: 'Adele', tonic: 0, videoTitle: 'Adele - Rolling in the Deep (Official Music Video)' },
  // asked for as Faouzia + "Unethical (Acoustic)", but the video is called "... (MAPHRA Vocal Cover)"
  { id: 'songDelta04', title: 'Unethical (Acoustic)', artist: 'Faouzia', tonic: 7, videoTitle: 'Faouzia - Unethical (MAPHRA Vocal Cover)' },
];

const LYRICS = [
  { start: 1.0, end: 4.0, text: 'Primeira linha da letra', words: [[1.0, 1.6], [1.6, 2.2], [2.2, 2.6], [2.6, 3.2], [3.2, 4.0]] },
  { start: 5.0, end: 8.0, text: 'Segunda linha cantada agora', words: [[5.0, 5.6], [5.6, 6.2], [6.2, 6.8], [6.8, 7.4], [7.4, 8.0]] },
  { start: 9.0, end: 12.0, text: 'Terceira e última linha', words: [[9.0, 9.8], [9.8, 10.2], [10.2, 11.0], [11.0, 12.0]] },
];

// a steady 30 s melody (one note every 2 s, in 50 ms frames), so the score has something to compare against
const MELODY = { hop: 0.05, midi: Array.from({ length: 600 }, (_, i) => [57, 60, 64, 62, 59][Math.floor(i / 40) % 5]) };

async function seed(root: string) {
  for (const song of SONGS) {
    const dir = join(root, 'cache', song.id);
    await mkdir(dir, { recursive: true });
    await copyFile(join(here, 'fixtures', 'tone.mp3'), join(dir, 'instrumental.mp3'));
    if (song.backing) await copyFile(join(here, 'fixtures', 'tone-440.mp3'), join(dir, 'backing.mp3')); // only some songs have backing vocals (in a key other than the instrumental's: the two summed stay measurable)
    if (song.backing) await copyFile(join(here, 'fixtures', 'tone-440.mp3'), join(dir, 'vocals.mp3')); // the original voice (the guide) exists in the same songs
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

// E2E_STORAGE: uses a real songs folder (read only) instead of the test ones (diagnosing with real files)
const root = process.env.E2E_STORAGE ? resolve(process.env.E2E_STORAGE) : await mkdtemp(join(tmpdir(), 'singalong-e2e-'));
if (!process.env.E2E_STORAGE) await seed(root);
const jobs = createMemoryJobStore();
const BIG = { max: 1e6, windowMs: 60_000 };
// adminToken turns on the local agent's pairing (/agent/v1): the tests in agent.spec.ts play the owner's app.
// The Intermission between songs: the tests' Rooms start with it off (the older tests expect the next song at once); the
// Intermission's tests turn it on, and it lasts E2E_INTERMISSION_MS in each phase (3 s, or more to watch the whole scenes).
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

type Request<Body> = { body: Body };

app.post('/__test/search-results', async (request: Request<unknown>) => {
  jobs.searchResults = request.body;
  return { ok: true };
});
// the fake agent "writes the song's files" as the real agent would when it finishes processing
app.post('/__test/seed-song', async (request: Request<{ id: string; title: string; artist: string }>) => {
  const { id, title, artist } = request.body;
  const dir = join(root, 'cache', id);
  await mkdir(dir, { recursive: true });
  await copyFile(join(here, 'fixtures', 'tone.mp3'), join(dir, 'instrumental.mp3'));
  await writeFile(join(dir, 'lyrics.json'), JSON.stringify(LYRICS));
  await writeFile(join(dir, 'meta.json'), JSON.stringify({ video_id: id, title, artist, duration: 30, lyrics_source: 'none' }));
  return { ok: true };
});
// deletes the seeded song: the library is shared between the tests and must not gain songs they do not expect
app.post('/__test/remove-song', async (request: Request<{ id: string }>) => {
  await rm(join(root, 'cache', request.body.id), { recursive: true, force: true });
  return { ok: true };
});
// drops the Session owner's sign of life (their app closed without warning)
app.post('/__test/session-offline', async (request: Request<{ id: string }>) => {
  await app.orm.em.fork().nativeUpdate(Session, { id: request.body.id, endedAt: null }, { lastSeen: Date.now() - 3_600_000 });
  return { ok: true };
});
app.get('/__test/state', async () => ({ queue: jobs.queue, exportQueue: jobs.exportQueue, searchQueries: jobs.searchQueries }));

// The agent's local media server (what the owner's app does on their computer): it serves the songs of `root/cache` from another
// origin, with CORS and Range, like media_server.py. It records the requests so the test checks where the TV fetched the audio.
const MEDIA_PORT = Number(process.env.E2E_MEDIA_PORT ?? 3101);
const mediaLog: { url: string | undefined; origin: string | undefined; range: string | null }[] = [];
const mediaServer = createServer(async (req, res) => {
  const origin = req.headers.origin;
  mediaLog.push({ url: req.url, origin, range: req.headers.range ?? null });
  const cors = {
    ...(origin ? { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' } : {}),
    'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length',
    'Access-Control-Allow-Headers': 'range',
  };
  if (req.method === 'OPTIONS') return res.writeHead(204, cors).end();
  const path = (req.url ?? '').split('?')[0];
  if (path === '/e2e/ping') return res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }).end('{"ok":true}');
  const match = /^\/e2e\/cache\/([A-Za-z0-9_-]{11})\/(instrumental\.mp3|lyrics\.json|melody\.json|backing\.mp3|vocals\.mp3)$/.exec(path);
  const file = match && join(root, 'cache', match[1], match[2]);
  const info = file && (await stat(file).catch(() => null));
  if (!file || !info) return res.writeHead(404, cors).end();
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
await new Promise<void>((resolveListen) => mediaServer.listen(MEDIA_PORT, '127.0.0.1', resolveListen));
app.get('/__test/media-log', async () => mediaLog);
app.delete('/__test/media-log', async () => { mediaLog.length = 0; return { ok: true }; });

app.rooms.start({ tickMs: 300 });
await app.listen({ port: PORT, host: '127.0.0.1' });
console.log(`e2e at http://127.0.0.1:${PORT} (pages: ${publicDir})`);
