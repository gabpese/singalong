import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.wav': 'audio/wav',
  '.svg': 'image/svg+xml',
};

/** Interpreta o header Range (um único intervalo). null = sem Range; 'invalid' = não satisfazível. */
export function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid';
  let start;
  let end;
  if (m[1] === '') {
    start = Math.max(size - Number(m[2]), 0);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return start > end || start >= size ? 'invalid' : { start, end };
}

/** Envia um arquivo com suporte a Range (necessário para o <audio> fazer seek). */
export async function sendFile(request, reply, file, { cache = 'no-cache' } = {}) {
  let info;
  try {
    info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
  } catch {
    return reply.code(404).send({ error: 'not_found' });
  }
  reply.header('Content-Type', TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream');
  reply.header('Accept-Ranges', 'bytes');
  reply.header('Cache-Control', cache);
  const range = parseRange(request.headers.range, info.size);
  if (range === 'invalid') {
    return reply.code(416).header('Content-Range', `bytes */${info.size}`).send();
  }
  if (range) {
    reply.code(206);
    reply.header('Content-Range', `bytes ${range.start}-${range.end}/${info.size}`);
    reply.header('Content-Length', range.end - range.start + 1);
    return request.method === 'HEAD' ? reply.send() : reply.send(createReadStream(file, range));
  }
  reply.header('Content-Length', info.size);
  return request.method === 'HEAD' ? reply.send() : reply.send(createReadStream(file));
}
