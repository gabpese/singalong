// API do agente local (/agent/v1): pareamento, sessões e as filas de trabalho (jobs, busca e exportação).
//
// O agente é o app instalado no computador do dono. Ele só faz conexões de SAÍDA: pareia uma vez com um código, inicia uma
// sessão, cria as salas dela e fica puxando trabalho (long-poll). Só o agente dono da sessão de uma sala recebe os
// pedidos dessa sala. Autenticação: `Authorization: Bearer <token do dispositivo>`.
import { MAX_NAME, safeEqual } from '../agents.js';
import { MAX_WAIT_MS } from '../jobs.js';
import { HttpError } from '../rooms.js';
import { rateLimited } from '../rate-limit.js';

const JOB_ID = { type: 'string', pattern: '^[A-Za-z0-9_-]{11,14}$' };
const WAIT = { type: 'object', additionalProperties: false, properties: { wait_ms: { type: 'integer', minimum: 0, maximum: MAX_WAIT_MS } } };
const TEXT = { type: 'string', maxLength: 500 };
const JOB_FIELDS = { stage: TEXT, error: TEXT, error_code: { type: 'string', maxLength: 60 }, retry: { type: 'string', maxLength: 20 } };
const SEARCH_ITEM = {
  type: 'object',
  additionalProperties: false,
  properties: {
    video_id: { type: 'string', pattern: '^[A-Za-z0-9_-]{11}$' },
    title: { type: 'string', maxLength: 300 },
    channel: { type: ['string', 'null'], maxLength: 200 },
    duration: { type: ['number', 'null'] },
  },
  required: ['video_id', 'title'],
};

export async function agentRoutes(app, { agents, jobs, rooms, config, limiters }) {
  app.decorateRequest('device', null);

  /** Exige o token de dispositivo; deixa o dispositivo em `request.device`. */
  async function authenticate(request) {
    const header = String(request.headers.authorization ?? '');
    const device = header.startsWith('Bearer ') ? agents.authenticate(header.slice(7).trim()) : null;
    if (!device) throw new HttpError(401, 'unauthorized', 'Dispositivo não autorizado. Pareie de novo.');
    request.device = device;
  }
  const auth = { preHandler: authenticate };

  /** A sessão ativa do dispositivo (e já conta como sinal de vida); 409 se ele ainda não iniciou uma. */
  function activeSession(request) {
    const session = agents.touch(request.device);
    if (!session) throw new HttpError(409, 'no_active_session', 'Inicie uma sessão antes de pedir trabalho.');
    return session;
  }

  // --- pareamento ---

  // Quem chama já é o administrador do servidor (ADMIN_TOKEN). Sem esse segredo configurado o pareamento fica desligado.
  app.post('/pair/start', { preHandler: rateLimited(limiters.pair) }, async (request, reply) => {
    if (!config.adminToken) return reply.code(404).send({ error: 'not_found' });
    if (!safeEqual(request.headers['x-admin-token'], config.adminToken)) {
      throw new HttpError(403, 'forbidden', 'Token de administrador inválido.');
    }
    return reply.code(201).send(agents.startPairing());
  });

  app.post('/pair/complete', {
    preHandler: rateLimited(limiters.pair),
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: { code: { type: 'string', minLength: 4, maxLength: 20 }, name: { type: 'string', maxLength: 60 } },
        required: ['code'],
      },
    },
  }, async (request, reply) => reply.code(201).send(agents.completePairing(request.body.code, request.body.name)));

  // --- dispositivo e sessão ---

  app.get('/me', auth, async (request) => {
    const session = agents.activeSession(request.device);
    return {
      device: { id: request.device.id, name: request.device.name },
      session: session ? { id: session.id, display_name: session.display_name } : null,
    };
  });

  app.delete('/devices/me', auth, async (request, reply) => {
    await agents.revoke(request.device);
    return reply.code(204).send();
  });

  app.post('/sessions', {
    ...auth,
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: { display_name: { type: 'string', minLength: 1, maxLength: MAX_NAME * 2 }, resume_id: { type: 'string', maxLength: 64 } },
        required: ['display_name'],
      },
    },
  }, async (request, reply) => {
    const session = await agents.startSession(request.device, request.body.display_name, { resumeId: request.body.resume_id });
    return reply.code(201).send({ id: session.id, display_name: session.display_name });
  });

  app.delete('/sessions/:id', auth, async (request, reply) => {
    await agents.endSession(agents.ownSession(request.device, request.params.id));
    return reply.code(204).send();
  });

  // O dono cria as salas da própria sessão (o navegador abre a página como anfitrião, com o host_token).
  app.post('/sessions/:id/rooms', { ...auth, preHandler: [authenticate, rateLimited(limiters.createRoom)] }, async (request, reply) => {
    const session = agents.ownSession(request.device, request.params.id);
    if (session.ended_at) throw new HttpError(409, 'session_ended', 'A sessão já terminou.');
    return reply.code(201).send({ ...rooms.createRoom({ sessionId: session.id }), session_id: session.id });
  });

  app.post('/heartbeat', {
    ...auth,
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: { version: { type: 'string', maxLength: 40 }, hardware: { type: 'object' } },
      },
    },
  }, async (request) => ({ ok: true, session_id: agents.touch(request.device)?.id ?? null, server_time: Date.now() }));

  // --- jobs de processamento ---

  app.post('/jobs/claim', { ...auth, schema: { body: WAIT } }, async (request, reply) => {
    const session = activeSession(request);
    const job = await jobs.claim(session.id, request.device.id, { waitMs: request.body?.wait_ms ?? 0 });
    agents.touch(request.device); // a espera pode ter durado até 25 s: renova o sinal de vida
    return job ? { job } : reply.code(204).send();
  });

  const notYours = () => new HttpError(409, 'not_your_job', 'Este job não está com este agente.');

  app.post('/jobs/:id/progress', {
    ...auth,
    schema: { params: { type: 'object', properties: { id: JOB_ID }, required: ['id'] }, body: { type: 'object', additionalProperties: false, properties: JOB_FIELDS } },
  }, async (request, reply) => {
    agents.touch(request.device);
    if (!(await jobs.progress(request.params.id, request.device.id, request.body ?? {}))) throw notYours();
    return reply.code(204).send();
  });

  app.post('/jobs/:id/complete', {
    ...auth,
    schema: {
      params: { type: 'object', properties: { id: JOB_ID }, required: ['id'] },
      body: { type: 'object', additionalProperties: false, properties: { status: { enum: ['ready', 'needs_lyrics', 'failed'] }, ...JOB_FIELDS }, required: ['status'] },
    },
  }, async (request, reply) => {
    agents.touch(request.device);
    const { status, ...fields } = request.body;
    if (!(await jobs.complete(request.params.id, request.device.id, status, fields))) throw notYours();
    return reply.code(204).send();
  });

  // --- busca no YouTube ---

  app.post('/search/claim', { ...auth, schema: { body: WAIT } }, async (request, reply) => {
    const session = activeSession(request);
    const found = await jobs.claimSearch(session.id, { waitMs: request.body?.wait_ms ?? 0 });
    agents.touch(request.device);
    return found ? { request: found } : reply.code(204).send();
  });

  app.post('/search/:id/result', {
    ...auth,
    schema: {
      params: { type: 'object', properties: { id: { type: 'string', maxLength: 64 } }, required: ['id'] },
      body: {
        type: 'object',
        additionalProperties: false,
        properties: { results: { type: 'array', maxItems: 20, items: SEARCH_ITEM }, error: TEXT },
        minProperties: 1,
      },
    },
  }, async (request, reply) => {
    const session = activeSession(request);
    if (!(await jobs.replySearch(session.id, request.params.id, request.body))) {
      throw new HttpError(409, 'unknown_search', 'Esta busca não é desta sessão ou já venceu.');
    }
    return reply.code(204).send();
  });

  // --- exportação de MP4 ---

  app.post('/exports/claim', { ...auth, schema: { body: WAIT } }, async (request, reply) => {
    const session = activeSession(request);
    const found = await jobs.claimExport(session.id, { waitMs: request.body?.wait_ms ?? 0 });
    agents.touch(request.device);
    return found ? { request: found } : reply.code(204).send();
  });

  app.post('/exports/:id/:pitch/state', {
    ...auth,
    schema: {
      params: { type: 'object', properties: { id: JOB_ID, pitch: { type: 'integer', minimum: -6, maximum: 6 } }, required: ['id', 'pitch'] },
      body: { type: 'object', additionalProperties: false, properties: { status: { enum: ['processing', 'ready', 'failed'] }, error: TEXT }, required: ['status'] },
    },
  }, async (request, reply) => {
    const session = activeSession(request);
    const { id, pitch } = request.params;
    if (!(await jobs.setExportState(session.id, id, pitch, request.body.status, request.body.error))) {
      throw new HttpError(409, 'unknown_export', 'Esta exportação não é desta sessão.');
    }
    return reply.code(204).send();
  });
}
