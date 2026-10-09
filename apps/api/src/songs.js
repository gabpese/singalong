// Serviço de músicas: biblioteca (cache), estado do processamento e pedidos de job.
// Usado pelas rotas de músicas e pelas salas (adicionar à fila).

const keys = (id) => ({
  instrumental: `cache/${id}/instrumental.mp3`,
  lyrics: `cache/${id}/lyrics.json`,
  meta: `cache/${id}/meta.json`,
});

export function createSongService({ storage, jobs }) {
  /** "Pronto" = os três artefatos existem (uma pasta parcial de job interrompido não conta). */
  async function isReady(id) {
    const k = keys(id);
    const found = await Promise.all([storage.exists(k.instrumental), storage.exists(k.lyrics), storage.exists(k.meta)]);
    return found.every(Boolean);
  }

  async function readMeta(id) {
    return JSON.parse((await storage.read(keys(id).meta)).toString('utf-8'));
  }

  /** Estado público de uma música (null se nunca foi pedida). */
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

  function payloadFor(id, { lyrics, artist, title }) {
    const choice = lyrics ?? { source: 'auto' };
    return {
      url: `https://www.youtube.com/watch?v=${id}`, // sempre canônica: o usuário não escolhe o alvo do yt-dlp
      lyrics_source: choice.source,
      ...(choice.text ? { lyrics_text: choice.text } : {}),
      ...(choice.loose ? { lyrics_loose: true } : {}),
      ...(artist ? { artist } : {}),
      ...(title ? { title } : {}),
    };
  }

  return {
    isReady,
    describe,

    /** Músicas prontas (metadados do meta.json). */
    async list() {
      const metaKeys = (await storage.list('cache')).filter((key) => key.endsWith('/meta.json'));
      const songs = [];
      for (const key of metaKeys) {
        const id = key.split('/')[1];
        if (await isReady(id)) songs.push(await readMeta(id));
      }
      return songs;
    },

    /** Usa o cache se estiver pronto; senão cria um job (ou reaproveita o que está em andamento: dedupe). */
    async request(id, body = {}) {
      const explicitLyrics = body.lyrics && body.lyrics.source !== 'auto';
      if ((await isReady(id)) && !explicitLyrics) {
        return { cached: true, created: false, deduped: false, song: await describe(id) };
      }
      const { created } = await jobs.enqueue(id, payloadFor(id, body), { replace: Boolean(explicitLyrics) });
      return { cached: false, created, deduped: !created, song: await describe(id) };
    },

    /** Escolhe/troca a letra (reaproveita o instrumental do cache). error: 'not_found' | 'in_progress'. */
    async setLyrics(id, lyrics, { artist, title } = {}) {
      if (!(await describe(id))) return { error: 'not_found' };
      const { created } = await jobs.enqueue(id, payloadFor(id, { lyrics, artist, title }), { replace: true });
      if (!created) return { error: 'in_progress' };
      return { song: await describe(id) };
    },
  };
}
