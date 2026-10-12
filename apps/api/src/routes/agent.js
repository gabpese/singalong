// API do agente local (/agent/v1): pareamento, sessões e as filas de trabalho (jobs, busca e exportação).
//
// O agente é o app instalado no computador do dono. Ele só faz conexões de SAÍDA: pareia uma vez com um código, inicia uma
// sessão, cria as salas dela e fica puxando trabalho (long-poll). Só o agente dono da sessão de uma sala recebe os
// pedidos dessa sala. Autenticação: `Authorization: Bearer <token do dispositivo>`.
import { MAX_LIBRARY_BATCH, MAX_NAME, VIDEO_ID_PATTERN, safeEqual } from '../agents.js';
import { MAX_WAIT_MS } from '../jobs.js';
import { HttpError } from '../rooms.js';
import { rateLimited } from '../rate-limit.js';
import { pairingEmail } from '../mailer.js';
import { updateInfo } from '../version.js';

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

export async function agentRoutes(app, { agents, jobs, rooms, config, limiters, mailer }) {
  app.decorateRequest('device', null);

  /** Exige o token de dispositivo; deixa o dispositivo em `request.device`. */
  async function authenticate(request) {
    const header = String(request.headers.authorization ?? '');
    const device = header.startsWith('Bearer ') ? agents.authenticate(header.slice(7).trim()) : null;
    if (!device) throw new HttpError(401, 'unauthorized', 'Dispositivo não autorizado. Pareie de novo.');
    request.device = device;
  }
  const auth = { preHandler: authenticate };

  const versionConfig = () => ({ latest: config.appLatestVersion, minimum: config.appMinVersion, notes: config.appNotes, url: config.appDownloadUrl });
  const reportedVersion = new Map(); // dispositivo → versão do último heartbeat (só em memória: o agente reenvia ao abrir)

  /** A sessão ativa do dispositivo (e já conta como sinal de vida); 409 se ele ainda não iniciou uma. */
  function activeSession(request) {
    if (updateInfo(reportedVersion.get(request.device.id), versionConfig()).status === 'update_required') {
      throw new HttpError(426, 'update_required', 'Esta versão do aplicativo é antiga demais. Atualize para continuar.');
    }
    const session = agents.touch(request.device);
    if (!session) throw new HttpError(409, 'no_active_session', 'Inicie uma sessão antes de pedir trabalho.');
    return session;
  }

  // --- versão ---

  // Aberto (sem token): o app confere antes mesmo de parear. `?current=1.2.3` → o que fazer.
  app.get('/version', { schema: { querystring: { type: 'object', properties: { current: { type: 'string', maxLength: 60 } } } } }, async (request) => {
    return updateInfo(request.query.current, versionConfig());
  });

  // --- pareamento ---

  // Quem chama já é o administrador do servidor (ADMIN_TOKEN). Sem esse segredo configurado o pareamento fica desligado.
  app.post('/pair/start', { preHandler: rateLimited(limiters.pair) }, async (request, reply) => {
    if (!config.adminToken) return reply.code(404).send({ error: 'not_found' });
    if (!safeEqual(request.headers['x-admin-token'], config.adminToken)) {
      throw new HttpError(403, 'forbidden', 'Token de administrador inválido.');
    }
    return reply.code(201).send(agents.startPairing());
  });

  // A pessoa pede o código e informa o e-mail: ele só é enviado se o endereço estiver na lista do administrador
  // (PAIR_ALLOWED_EMAILS). A resposta é a mesma para qualquer e-mail, para ninguém descobrir quem está na lista; o envio roda
  // em segundo plano (o tempo de resposta também não revela nada).
  const EMAIL_SHAPE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
  app.post('/pair/request', {
    preHandler: rateLimited(limiters.pairRequest, { keyOf: (request) => request.ip }),
    schema: { body: { type: 'object', additionalProperties: false, properties: { email: { type: 'string', maxLength: 254 } }, required: ['email'] } },
  }, async (request, reply) => {
    if (!mailer?.enabled || config.pairAllowedEmails.length === 0) {
      throw new HttpError(503, 'email_disabled', 'Este servidor não envia códigos por e-mail. Peça o código a quem administra o servidor.');
    }
    const email = request.body.email.trim().toLowerCase();
    if (!EMAIL_SHAPE.test(email)) throw new HttpError(400, 'bad_email', 'Digite um e-mail válido.');
    const limited = limiters.pairEmail.hit(email);
    if (limited.ok && config.pairAllowedEmails.includes(email)) {
      const { code, expires_in: seconds } = agents.startPairing();
      const message = pairingEmail({ code, minutes: Math.round(seconds / 60), server: config.publicUrl || '' });
      mailer.send({ to: email, ...message }).catch((error) => request.log.error({ err: error.message }, 'não consegui enviar o código por e-mail'));
    }
    return reply.code(202).send({ ok: true, message: 'Se este e-mail estiver autorizado, o código chega em instantes. Olhe também a caixa de spam.' });
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
        properties: {
          display_name: { type: 'string', minLength: 1, maxLength: MAX_NAME * 2 },
          resume_id: { type: 'string', maxLength: 64 },
          // o servidor local de mídia do agente (http://127.0.0.1:porta/token): é de onde o navegador busca as músicas da sessão
          media_base: { type: 'string', maxLength: 200 },
        },
        required: ['display_name'],
      },
    },
  }, async (request, reply) => {
    const { display_name: name, resume_id: resumeId, media_base: mediaBase } = request.body;
    const session = await agents.startSession(request.device, name, { resumeId, mediaBase });
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
        properties: { version: { type: 'string', maxLength: 40 }, hardware: { type: 'object' }, media_base: { type: 'string', maxLength: 200 } },
      },
    },
  }, async (request) => {
    if (request.body?.version) reportedVersion.set(request.device.id, request.body.version);
    const session = agents.touch(request.device);
    if (session && request.body?.media_base !== undefined) agents.setMediaBase(session, request.body.media_base);
    return { ok: true, session_id: session?.id ?? null, server_time: Date.now(), update: updateInfo(request.body?.version, versionConfig()) };
  });

  // --- catálogo local: as músicas que estão no computador do dono ---

  // O agente publica o que tem (ao iniciar, e a cada música pronta, com vozes de apoio ou MP4 novos). Só o meta e quais arquivos existem.
  app.put('/library', {
    ...auth,
    schema: { body: { type: 'object', additionalProperties: false, properties: { songs: { type: 'array', maxItems: MAX_LIBRARY_BATCH, items: { type: 'object' } } }, required: ['songs'] } },
  }, async (request) => {
    agents.touch(request.device);
    return { count: agents.publishLibrary(request.device, request.body.songs) };
  });

  app.delete('/library/:id', {
    ...auth,
    schema: { params: { type: 'object', properties: { id: { type: 'string', pattern: VIDEO_ID_PATTERN } }, required: ['id'] } },
  }, async (request, reply) => {
    if (!agents.unpublish(request.device, request.params.id)) throw new HttpError(404, 'not_found', 'Esta música não está no catálogo.');
    return reply.code(204).send();
  });

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
