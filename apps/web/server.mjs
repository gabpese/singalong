// Servidor de desenvolvimento da Fase 1: estáticos + /media (storage local, com Range) + /api/songs.
// Sem dependências. Na Fase 2 o /media e o /api passam a ser da API Fastify.
import { createReadStream } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(here, 'public');
const STORAGE_ROOT = resolve(process.env.STORAGE_ROOT ?? join(here, '..', '..', 'storage'));
const PORT = Number(process.env.PORT ?? 3000);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.svg': 'image/svg+xml',
};

/** Resolve `rel` dentro de `root`; devolve null se escapar da pasta (path traversal). */
export function safeJoin(root, rel) {
  const full = resolve(root, normalize(rel).replace(/^([/\\])+/, ''));
  return full === root || full.startsWith(root + sep) ? full : null;
}

/** Interpreta o header Range (um único intervalo). null = sem Range; 'invalid' = não satisfazível. */
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid';
  let start;
  let end;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return start > end || start >= size ? 'invalid' : { start, end };
}

async function sendFile(req, res, file) {
  let info;
  try {
    info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
  } catch {
    res.writeHead(404).end('not found');
    return;
  }
  const headers = {
    'Content-Type': TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-cache',
    'Access-Control-Allow-Origin': '*',
  };
  const range = parseRange(req.headers.range, info.size);
  if (range === 'invalid') {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${info.size}` }).end();
    return;
  }
  if (range) {
    res.writeHead(206, {
      ...headers,
      'Content-Range': `bytes ${range.start}-${range.end}/${info.size}`,
      'Content-Length': range.end - range.start + 1,
    });
    if (req.method === 'HEAD') return void res.end();
    createReadStream(file, range).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': info.size });
  if (req.method === 'HEAD') return void res.end();
  createReadStream(file).pipe(res);
}

async function listSongs() {
  const base = join(STORAGE_ROOT, 'cache');
  let ids = [];
  try {
    ids = await readdir(base);
  } catch {
    return [];
  }
  const songs = [];
  for (const id of ids) {
    try {
      const meta = JSON.parse(await readFile(join(base, id, 'meta.json'), 'utf-8'));
      await stat(join(base, id, 'instrumental.mp3'));
      await stat(join(base, id, 'lyrics.json'));
      songs.push(meta);
    } catch {
      // pasta parcial (sem meta/instrumental/letra): ainda não está pronta
    }
  }
  return songs;
}

export function createApp() {
  return createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return void res.writeHead(405).end();
    const { pathname } = new URL(req.url, 'http://localhost');
    let path;
    try {
      path = decodeURIComponent(pathname);
    } catch {
      return void res.writeHead(400).end();
    }

    if (path === '/api/songs') {
      res.writeHead(200, { 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-cache' });
      return void res.end(JSON.stringify(await listSongs()));
    }
    if (path.startsWith('/media/')) {
      const file = safeJoin(STORAGE_ROOT, path.slice('/media/'.length));
      return file ? sendFile(req, res, file) : void res.writeHead(403).end('forbidden');
    }
    const file = safeJoin(PUBLIC_DIR, path === '/' ? 'index.html' : path);
    return file ? sendFile(req, res, file) : void res.writeHead(403).end('forbidden');
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  createApp().listen(PORT, () => {
    console.log(`singalong web: http://localhost:${PORT}  (storage: ${STORAGE_ROOT})`);
  });
}
