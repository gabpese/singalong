import { LYRICS_SCHEMA } from './songs.js';
import { HttpError, normalizeCode } from '../rooms.js';

const CODE_PARAM = { type: 'string', pattern: '^[A-Za-z0-9]{4,8}$' };
const ITEM_PARAMS = {
  type: 'object',
  properties: { code: CODE_PARAM, itemId: { type: 'integer', minimum: 1 } },
  required: ['code', 'itemId'],
};
const CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** Quem faz o pedido: id do navegador (X-Client-Id) e, se for o anfitrião, o token (X-Host-Token). */
function actorOf(request, { optional = false } = {}) {
  const clientId = String(request.headers['x-client-id'] ?? '');
  if (!CLIENT_ID.test(clientId) && !optional) {
    throw new HttpError(400, 'client_id_required', 'Identificação do navegador ausente.');
  }
  return { clientId: CLIENT_ID.test(clientId) ? clientId : '', hostToken: String(request.headers['x-host-token'] ?? '') };
}

/** Plugin Fastify: salas, fila, controle de reprodução e o WebSocket de estado. */
export async function roomRoutes(app, { rooms, config }) {
  app.get('/config', async () => ({ public_url: config.publicUrl || null }));

  app.post('/rooms', async (request, reply) => reply.code(201).send(rooms.createRoom()));

  app.get('/rooms/:code', { schema: { params: { type: 'object', properties: { code: CODE_PARAM } } } }, async (request) =>
    rooms.getState(request.params.code, actorOf(request, { optional: true })));

  app.patch('/rooms/:code', {
    schema: {
      params: { type: 'object', properties: { code: CODE_PARAM } },
      body: { type: 'object', additionalProperties: false, properties: { fair: { type: 'boolean' } }, required: ['fair'] },
    },
  }, async (request) => (await rooms.setFair(request.params.code, request.body.fair, actorOf(request))).state);

  app.post('/rooms/:code/queue', {
    schema: {
      params: { type: 'object', properties: { code: CODE_PARAM } },
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', maxLength: 300 },
          video_id: { type: 'string', pattern: '^[A-Za-z0-9_-]{11}$' },
          lyrics: LYRICS_SCHEMA,
          artist: { type: 'string', maxLength: 200 },
          title: { type: 'string', maxLength: 200 },
          display_title: { type: 'string', maxLength: 300 },
          name: { type: 'string', maxLength: 60 },
          pitch: { type: 'integer' },
        },
        anyOf: [{ required: ['url'] }, { required: ['video_id'] }],
      },
    },
  }, async (request, reply) => reply.code(201).send(await rooms.add(request.params.code, request.body, actorOf(request))));

  app.delete('/rooms/:code/queue/:itemId', { schema: { params: ITEM_PARAMS } }, async (request) =>
    (await rooms.remove(request.params.code, request.params.itemId, actorOf(request))).state);

  app.post('/rooms/:code/queue/:itemId/move', {
    schema: {
      params: ITEM_PARAMS,
      body: { type: 'object', additionalProperties: false, properties: { direction: { enum: ['up', 'down'] } }, required: ['direction'] },
    },
  }, async (request) => (await rooms.move(request.params.code, request.params.itemId, request.body.direction, actorOf(request))).state);

  app.patch('/rooms/:code/queue/:itemId', {
    schema: {
      params: ITEM_PARAMS,
      body: { type: 'object', additionalProperties: false, properties: { pitch: { type: 'integer' } }, required: ['pitch'] },
    },
  }, async (request) => (await rooms.setPitch(request.params.code, request.params.itemId, request.body.pitch, actorOf(request))).state);

  app.post('/rooms/:code/player/:action', {
    schema: {
      params: { type: 'object', properties: { code: CODE_PARAM, action: { enum: ['pause', 'resume', 'skip'] } }, required: ['code', 'action'] },
    },
  }, async (request) => {
    const { code, action } = request.params;
    const actor = actorOf(request);
    const result = action === 'skip' ? await rooms.skip(code, actor) : await rooms.setPlayback(code, action === 'resume', actor);
    return result.state;
  });

  app.put('/rooms/:code/songs/:videoId/offset', {
    schema: {
      params: {
        type: 'object',
        properties: { code: CODE_PARAM, videoId: { type: 'string', pattern: '^[A-Za-z0-9_-]{11}$' } },
        required: ['code', 'videoId'],
      },
      body: { type: 'object', additionalProperties: false, properties: { offset: { type: 'number' } }, required: ['offset'] },
    },
  }, async (request) => (await rooms.setOffset(request.params.code, request.params.videoId, request.body.offset, actorOf(request))).state);

  // Estado em tempo real. A TV (role=tv) também envia "ended" e "position".
  app.get('/rooms/:code/ws', { websocket: true }, (socket, request) => {
    const { role, client, host } = request.query;
    let session;
    try {
      session = rooms.connect(normalizeCode(request.params.code), {
        socket,
        role,
        clientId: CLIENT_ID.test(String(client ?? '')) ? client : '',
        hostToken: host,
      });
    } catch {
      socket.close(1008, 'room_not_found');
      return;
    }
    socket.on('pong', () => { session.conn.alive = true; });
    socket.on('message', (raw) => rooms.onMessage(normalizeCode(request.params.code), session.conn, raw));
    socket.on('close', () => session.leave());
  });
}
