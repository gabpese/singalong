import { createReadStream, type Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname } from 'node:path';
import type { FastifyReply, FastifyRequest } from 'fastify';

const TYPES: Record<string, string> = {
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

/** Reads the Range header (a single range). null = no Range; 'invalid' = it cannot be satisfied. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'invalid' | null {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid';
  let start: number;
  let end: number;
  if (m[1] === '') {
    start = Math.max(size - Number(m[2]), 0);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  return start > end || start >= size ? 'invalid' : { start, end };
}

/** Sends a file, with Range support (the <audio> element needs it to seek). */
export async function sendFile(request: FastifyRequest, reply: FastifyReply, file: string, { cache = 'no-cache' } = {}) {
  let info: Stats;
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
