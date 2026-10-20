// The cloud: the songs of authorized computers (ENABLED_TO_SEND_TO_CLOUD or the admin page) come to exist on the server.
import { type Static, Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Device } from '../database/entities.ts';
import { HttpError } from '../http-error.ts';
import type { LocalStorage } from '../storage.js';
import { OneOf } from '../validation.ts';
import { deviceOf } from './agent-auth.guard.ts';
import type { AgentService } from './agent.service.ts';
import { VIDEO_ID_PATTERN } from './agents.ts';

const MAX_CLOUD_FILE = 80 * 1024 * 1024; // a long song's instrumental as an MP3 comes nowhere near this
/** What may be sent to the cloud, and each file's limit (the isolated voice, source.json and the MP4s stay out). */
const CLOUD_FILES = {
  'instrumental.mp3': { kind: 'audio', max: MAX_CLOUD_FILE },
  'backing.mp3': { kind: 'audio', max: MAX_CLOUD_FILE },
  'lyrics.json': { kind: 'json', max: 10 * 1024 * 1024 },
  'melody.json': { kind: 'json', max: 10 * 1024 * 1024 },
  'meta.json': { kind: 'json', max: 1024 * 1024 },
} as const;
type CloudFile = keyof typeof CLOUD_FILES;

/** The files a song needs in the cloud to count as there. */
export const CLOUD_REQUIRED = ['instrumental.mp3', 'lyrics.json', 'meta.json'];

/** An MP3 starts with the ID3 tag or with an audio frame (11 bits set). */
const looksLikeMp3 = (data: Buffer) => (data[0] === 0x49 && data[1] === 0x44 && data[2] === 0x33) || (data[0] === 0xff && (data[1] & 0xe0) === 0xe0);

/** Only computers paired with an authorized e-mail send to the cloud, and only when the server has where to write. */
export async function requireCloud(agents: AgentService, storage: LocalStorage, device: Device): Promise<void> {
  if (!storage?.write || !(await agents.canUploadToCloud(device))) {
    throw new HttpError(403, 'cloud_not_allowed', 'Este computador não está autorizado a enviar músicas para a nuvem.');
  }
  await agents.touch(device);
}

const CloudFileParams = Type.Object({
  id: Type.String({ pattern: VIDEO_ID_PATTERN }),
  file: OneOf(Object.keys(CLOUD_FILES) as CloudFile[]),
});

/**
 * One file of a song, raw in the body (application/octet-stream). It stays a Fastify route, in a context of its own: the
 * octet-stream parser and the 80 MB limit hold only here. The token is checked before the body is read, so nobody without
 * one makes the server take in a file.
 */
export async function cloudUploads(app: FastifyInstance, { agents, storage }: { agents: AgentService; storage: LocalStorage }) {
  app.addContentTypeParser('application/octet-stream', { parseAs: 'buffer', bodyLimit: MAX_CLOUD_FILE }, (_request, body, done) => done(null, body));
  const devices = new WeakMap<FastifyRequest, Device>();

  // meta.json goes last: only with it does the song count as ready, so nobody plays half a song
  app.put<{ Params: Static<typeof CloudFileParams>; Body: unknown }>('/cloud/:id/:file', {
    bodyLimit: MAX_CLOUD_FILE,
    schema: { params: CloudFileParams },
    onRequest: async (request) => {
      devices.set(request, await deviceOf(agents, request.headers.authorization));
    },
  }, async (request, reply) => {
    await requireCloud(agents, storage, devices.get(request)!);
    const { id, file } = request.params;
    if (await agents.isSongBlocked(id)) throw new HttpError(403, 'cloud_blocked', 'Esta música foi tirada da nuvem pelo administrador.');
    const rule = CLOUD_FILES[file];
    const data = request.body;
    if (!Buffer.isBuffer(data) || data.length === 0) throw new HttpError(400, 'empty_file', 'O arquivo está vazio.');
    if (data.length > rule.max) throw new HttpError(413, 'file_too_big', 'O arquivo é grande demais.');
    if (rule.kind === 'audio' && !looksLikeMp3(data)) throw new HttpError(400, 'bad_file', 'O áudio não parece um MP3.');
    if (rule.kind === 'json') {
      let parsed: { video_id?: unknown } | null;
      try {
        parsed = JSON.parse(data.toString('utf8'));
      } catch {
        throw new HttpError(400, 'bad_file', 'O arquivo não é um JSON válido.');
      }
      if (file === 'meta.json') {
        if (parsed?.video_id !== id) throw new HttpError(400, 'bad_file', 'O meta.json não é desta música.');
        const ready = await Promise.all(['instrumental.mp3', 'lyrics.json'].map((name) => storage.exists(`cache/${id}/${name}`)));
        if (!ready.every(Boolean)) throw new HttpError(409, 'incomplete', 'Envie o instrumental e a letra antes do meta.json.');
      }
    }
    await storage.write(`cache/${id}/${file}`, data);
    return reply.code(204).send();
  });
}
