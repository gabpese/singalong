import { extractVideoId } from '../youtube.js';

const ID_PARAM = { type: 'object', properties: { id: { type: 'string', pattern: '^[A-Za-z0-9_-]{11}$' } }, required: ['id'] };

const LYRICS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    // auto: legenda do vídeo; lrclib: busca online; text: letra pura (usa os tempos do vídeo/online);
    // file: conteúdo LRC/SRT/VTT com tempos; align: letra pura sincronizada com a voz por IA; none: só o instrumental
    source: { enum: ['auto', 'lrclib', 'text', 'file', 'align', 'none'] },
    text: { type: 'string', maxLength: 100_000 },
    // aceita a letra online de uma versão com duração diferente da do vídeo
    loose: { type: 'boolean' },
  },
  required: ['source'],
};

// PUT: a mesma escolha de letra, mais artista/título para a busca no LRCLIB (vídeos sem "Artista - Música" no título)
const PUT_LYRICS_SCHEMA = {
  ...LYRICS_SCHEMA,
  properties: {
    ...LYRICS_SCHEMA.properties,
    artist: { type: 'string', maxLength: 200 },
    title: { type: 'string', maxLength: 200 },
  },
};

const keys = (id) => ({
  instrumental: `cache/${id}/instrumental.mp3`,
  lyrics: `cache/${id}/lyrics.json`,
  meta: `cache/${id}/meta.json`,
});

/** Plugin Fastify com as rotas de músicas (biblioteca + jobs de processamento). */
export async function songRoutes(app, { storage, jobs }) {
  /** "Pronto" = os três artefatos existem (uma pasta parcial de job interrompido não conta). */
  async function isReady(id) {
    const k = keys(id);
    const found = await Promise.all([storage.exists(k.instrumental), storage.exists(k.lyrics), storage.exists(k.meta)]);
    return found.every(Boolean);
  }

  async function readMeta(id) {
    return JSON.parse((await storage.read(keys(id).meta)).toString('utf-8'));
  }

  async function describe(id) {
    const [job, ready] = await Promise.all([jobs.get(id), isReady(id)]);
    if (!job && !ready) return null;
    // um job em andamento (ex.: trocando a letra) tem prioridade sobre o "pronto" anterior
    const jobActive = job && ['pending', 'processing', 'needs_lyrics', 'failed'].includes(job.status);
    const status = jobActive ? job.status : ready ? 'ready' : job.status;
    const k = keys(id);
    return {
      video_id: id,
      status,
      stage: jobActive ? job.stage : null,
      error: jobActive ? job.error : null,
      meta: ready ? await readMeta(id) : null,
      media: ready ? { instrumental: storage.getUrl(k.instrumental), lyrics: storage.getUrl(k.lyrics) } : null,
    };
  }

  function payloadFor(id, body) {
    const lyrics = body.lyrics ?? { source: 'auto' };
    return {
      url: `https://www.youtube.com/watch?v=${id}`, // sempre canônica: o usuário não escolhe o alvo do yt-dlp
      lyrics_source: lyrics.source,
      ...(lyrics.text ? { lyrics_text: lyrics.text } : {}),
      ...(lyrics.loose ? { lyrics_loose: true } : {}),
      ...(body.artist ? { artist: body.artist } : {}),
      ...(body.title ? { title: body.title } : {}),
    };
  }

  function needsText(lyrics) {
    return lyrics && ['text', 'file', 'align'].includes(lyrics.source) && !lyrics.text?.trim();
  }

  // Pesquisa de vídeos no YouTube (atendida pelo worker); o link escolhido segue para POST /songs.
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

  // Biblioteca: músicas prontas (metadados do meta.json)
  app.get('/songs', async () => {
    const metaKeys = (await storage.list('cache')).filter((key) => key.endsWith('/meta.json'));
    const songs = [];
    for (const key of metaKeys) {
      const id = key.split('/')[1];
      if (await isReady(id)) songs.push(await readMeta(id));
    }
    return songs;
  });

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
    const lyrics = request.body.lyrics;
    if (needsText(lyrics)) {
      return reply.code(400).send({ error: 'lyrics_text_required', message: 'Informe o texto da letra.' });
    }

    const explicitLyrics = lyrics && lyrics.source !== 'auto';
    if ((await isReady(id)) && !explicitLyrics) {
      return reply.code(200).send({ ...(await describe(id)), cached: true });
    }
    const { created } = await jobs.enqueue(id, payloadFor(id, request.body), { replace: Boolean(explicitLyrics) });
    return reply.code(created ? 202 : 200).send({ ...(await describe(id)), deduped: !created });
  });

  app.get('/songs/:id', { schema: { params: ID_PARAM } }, async (request, reply) => {
    const song = await describe(request.params.id);
    return song ?? reply.code(404).send({ error: 'not_found' });
  });

  // Escolha/troca da fonte da letra (reaproveita o instrumental do cache; só refaz a letra).
  app.put('/songs/:id/lyrics', {
    schema: { params: ID_PARAM, body: PUT_LYRICS_SCHEMA },
  }, async (request, reply) => {
    const { id } = request.params;
    const { artist, title, ...lyrics } = request.body;
    if (needsText(lyrics)) {
      return reply.code(400).send({ error: 'lyrics_text_required', message: 'Informe o texto da letra.' });
    }
    if (!(await describe(id))) return reply.code(404).send({ error: 'not_found' });
    const { created } = await jobs.enqueue(id, payloadFor(id, { lyrics, artist, title }), { replace: true });
    if (!created) return reply.code(409).send({ error: 'job_in_progress', message: 'A música ainda está sendo processada.' });
    return reply.code(202).send(await describe(id));
  });
}
