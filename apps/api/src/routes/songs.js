import { extractVideoId } from '../youtube.js';

const ID_PARAM = { type: 'object', properties: { id: { type: 'string', pattern: '^[A-Za-z0-9_-]{11}$' } }, required: ['id'] };

export const LYRICS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    // auto: legenda do vídeo; lrclib: busca online (+ IA se preciso); text: letra pura com os tempos de outra fonte;
    // file: conteúdo LRC/SRT/VTT com tempos; align: letra pura sincronizada com a voz por IA; none: só o instrumental
    source: { enum: ['auto', 'lrclib', 'text', 'file', 'align', 'none'] },
    text: { type: 'string', maxLength: 100_000 },
    // usa a letra online de uma versão com duração diferente, com os tempos dela (sem IA)
    loose: { type: 'boolean' },
  },
  required: ['source'],
};

// PUT: a mesma escolha de letra, mais artista/título para a busca online (vídeos sem "Artista - Música" no título)
const PUT_LYRICS_SCHEMA = {
  ...LYRICS_SCHEMA,
  properties: {
    ...LYRICS_SCHEMA.properties,
    artist: { type: 'string', maxLength: 200 },
    title: { type: 'string', maxLength: 200 },
  },
};

/** Letra que exige texto (text/file/align) sem texto. */
export function missingLyricsText(lyrics) {
  return Boolean(lyrics) && ['text', 'file', 'align'].includes(lyrics.source) && !lyrics.text?.trim();
}

/** Plugin Fastify com as rotas de músicas (biblioteca, jobs de processamento e pesquisa). */
export async function songRoutes(app, { songs, jobs }) {
  // Pesquisa de vídeos no YouTube (atendida pelo worker); o link escolhido segue para POST /songs ou para a fila.
  app.get('/search', {
    schema: {
      querystring: {
        type: 'object',
        properties: { q: { type: 'string', minLength: 2, maxLength: 100 } },
        required: ['q'],
      },
    },
  }, async (request, reply) => {
    try {
      const results = await jobs.search(request.query.q);
      return results.map((r) => ({ ...r, thumbnail: `https://i.ytimg.com/vi/${r.video_id}/mqdefault.jpg` }));
    } catch (err) {
      request.log.warn({ err: err.message }, 'busca falhou');
      return reply.code(503).send({ error: 'search_unavailable', message: 'A busca não está disponível agora. Tente de novo ou cole o link do vídeo.' });
    }
  });

  app.get('/songs', async () => songs.list());

  // Adiciona um link: usa o cache se já estiver pronto; senão cria um job (ou reaproveita o que está em andamento).
  app.post('/songs', {
    schema: {
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string', maxLength: 300 },
          lyrics: LYRICS_SCHEMA,
          artist: { type: 'string', maxLength: 200 },
          title: { type: 'string', maxLength: 200 },
        },
        required: ['url'],
      },
    },
  }, async (request, reply) => {
    const id = extractVideoId(request.body.url);
    if (!id) return reply.code(400).send({ error: 'invalid_url', message: 'Link do YouTube inválido.' });
    if (missingLyricsText(request.body.lyrics)) {
      return reply.code(400).send({ error: 'lyrics_text_required', message: 'Informe o texto da letra.' });
    }
    const { cached, created, deduped, song } = await songs.request(id, request.body);
    if (cached) return reply.code(200).send({ ...song, cached: true });
    return reply.code(created ? 202 : 200).send({ ...song, deduped });
  });

  app.get('/songs/:id', { schema: { params: ID_PARAM } }, async (request, reply) => {
    const song = await songs.describe(request.params.id);
    return song ?? reply.code(404).send({ error: 'not_found' });
  });

  // Escolha/troca da fonte da letra (reaproveita o instrumental do cache; só refaz a letra).
  app.put('/songs/:id/lyrics', {
    schema: { params: ID_PARAM, body: PUT_LYRICS_SCHEMA },
  }, async (request, reply) => {
    const { artist, title, ...lyrics } = request.body;
    if (missingLyricsText(lyrics)) {
      return reply.code(400).send({ error: 'lyrics_text_required', message: 'Informe o texto da letra.' });
    }
    const result = await songs.setLyrics(request.params.id, lyrics, { artist, title });
    if (result.error === 'not_found') return reply.code(404).send({ error: 'not_found' });
    if (result.error === 'in_progress') {
      return reply.code(409).send({ error: 'job_in_progress', message: 'A música ainda está sendo processada.' });
    }
    return reply.code(202).send(result.song);
  });
}
