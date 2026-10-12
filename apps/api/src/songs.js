// Serviço de músicas: biblioteca (cache), estado do processamento e pedidos de job.
// Usado pelas rotas de músicas e pelas salas (adicionar à fila).
//
// Dois lugares onde uma música pode estar:
//  - no armazenamento do SERVIDOR (o jeito clássico: o worker e a API compartilham a pasta `storage/`);
//  - no COMPUTADOR DO DONO da sessão (armazenamento local): a nuvem não vê os arquivos, só o catálogo que o agente publica
//    (o meta.json e quais arquivos existem) e o endereço do servidor local de mídia, de onde o navegador os busca.
// Qual vale depende do contexto `{ sessionId }`: se a sessão tem `media_base`, é o catálogo dela; senão, o servidor.

const keys = (id) => ({
  instrumental: `cache/${id}/instrumental.mp3`,
  lyrics: `cache/${id}/lyrics.json`,
  meta: `cache/${id}/meta.json`,
  melody: `cache/${id}/melody.json`, // opcional: a melodia da voz original, para a pontuação
  backing: `cache/${id}/backing.mp3`, // opcional: só as vozes de apoio, para o controle de nível delas
});

/** Chave do MP4 exportado: o mesmo nome que o worker usa (karaoke.mp4, karaoke_p+2.mp4, karaoke_p-3.mp4). */
export const exportKey = (id, pitch) => `cache/${id}/karaoke${pitch === 0 ? '' : `_p${pitch > 0 ? '+' : '-'}${Math.abs(pitch)}`}.mp4`;

/** Uma música importada (arquivo ou fonte aberta do dono): "f-" + 12 hexadecimais. Não vem do YouTube, então não há o que baixar. */
const isImported = (id) => id.startsWith('f-');

export function createSongService({ storage, jobs, agents = null }) {
  /** O catálogo local do contexto (de quem é e onde está a mídia), ou null: a música está no servidor. */
  const localOf = ({ sessionId = null } = {}) => (agents && sessionId ? agents.libraryOfSession(sessionId) : null);
  const localUrl = (lib, key) => `${lib.mediaBase}/${key}`;

  /**
   * Um pedido pendente com um dono que SUMIU (sessão sem sinal) não pode prender a música para os outros: ele é liberado
   * (vira falha "o dono saiu") e o pedido novo segue. Se o dono dele está online, o pedido continua com ele (dedupe).
   */
  async function releaseStale(id, sessionId) {
    const job = await jobs.get(id);
    if (!job?.session_id || job.session_id === sessionId || !['pending', 'processing'].includes(job.status)) return;
    if (agents?.isOnline(job.session_id)) return;
    await jobs.release?.(id);
  }

  /** Pronta no catálogo do computador do dono desta sessão? */
  const localReady = (lib, id) => {
    const files = agents.librarySong(lib.deviceId, id)?.files;
    return Boolean(files?.instrumental && files?.lyrics);
  };

  /** Pronta no armazenamento do servidor (a "nuvem")? Os três artefatos existem: uma pasta parcial de job interrompido não conta. */
  async function cloudReady(id) {
    const k = keys(id);
    const found = await Promise.all([storage.exists(k.instrumental), storage.exists(k.lyrics), storage.exists(k.meta)]);
    return found.every(Boolean);
  }

  /**
   * "Pronto": no catálogo local da sessão OU na nuvem (músicas que computadores autorizados enviaram: qualquer sessão as usa,
   * sem baixar de novo do YouTube).
   */
  async function isReady(id, ctx) {
    const lib = localOf(ctx);
    if (lib && localReady(lib, id)) return true;
    return cloudReady(id);
  }

  async function readMeta(id) {
    return JSON.parse((await storage.read(keys(id).meta)).toString('utf-8'));
  }

  /** Os endereços dos arquivos de uma música pronta (null onde o arquivo opcional não existe). */
  async function mediaOf(id, ctx) {
    const lib = localOf(ctx);
    const k = keys(id);
    if (lib && localReady(lib, id)) { // o computador do dono é mais rápido: a TV dele busca ali
      const files = agents.librarySong(lib.deviceId, id).files;
      return {
        instrumental: localUrl(lib, k.instrumental),
        lyrics: localUrl(lib, k.lyrics),
        melody: files.melody ? localUrl(lib, k.melody) : null,
        backing: files.backing ? localUrl(lib, k.backing) : null,
        local: true, // os arquivos estão no computador do dono: só o navegador dele (a TV) os alcança
      };
    }
    return {
      instrumental: storage.getUrl(k.instrumental),
      lyrics: storage.getUrl(k.lyrics),
      melody: (await storage.exists(k.melody)) ? storage.getUrl(k.melody) : null,
      backing: (await storage.exists(k.backing)) ? storage.getUrl(k.backing) : null,
      local: false,
    };
  }

  /** Estado público de uma música (null se nunca foi pedida). */
  async function describe(id, ctx) {
    const [job, ready] = await Promise.all([jobs.get(id), isReady(id, ctx)]);
    if (!job && !ready) return null;
    // sobrou só o registro "pronto" no Redis mas os arquivos foram apagados (limpeza do cache): é como se nunca tivesse existido
    if (!ready && job?.status === 'ready') return null;
    // um job em andamento (ex.: trocando a letra) tem prioridade sobre o "pronto" anterior
    const jobActive = job && ['pending', 'processing', 'needs_lyrics', 'failed'].includes(job.status);
    const status = jobActive ? job.status : ready ? 'ready' : job.status;
    const lib = localOf(ctx);
    return {
      video_id: id,
      status,
      stage: jobActive ? job.stage : null,
      error: jobActive ? job.error : null,
      error_code: jobActive ? job.error_code ?? null : null,
      retry: jobActive ? job.retry ?? null : null,
      meta: ready ? (lib && localReady(lib, id) ? agents.librarySong(lib.deviceId, id).meta : await readMeta(id)) : null,
      media: ready ? await mediaOf(id, ctx) : null,
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

  /** Estado do MP4 de uma música num tom: o arquivo existir é a verdade (o estado no Redis expira). */
  async function exportInfo(id, pitch, ctx) {
    const lib = localOf(ctx);
    if (lib) {
      // o agente publica no catálogo os tons que já têm MP4 no computador do dono
      const exports = agents.librarySong(lib.deviceId, id)?.files.exports ?? [];
      if (exports.includes(pitch)) return { status: 'ready', url: localUrl(lib, exportKey(id, pitch)), error: null, local: true };
    } else {
      const key = exportKey(id, pitch);
      if (await storage.exists(key)) return { status: 'ready', url: storage.getUrl(key), error: null };
    }
    const state = await jobs.exportState(id, pitch);
    // "ready" sem arquivo = limpeza do cache: é como se nunca tivesse sido pedido
    return state && state.status !== 'ready' ? { ...state, url: null } : { status: 'none', url: null, error: null };
  }

  return {
    isReady,
    describe,
    exportInfo,

    /** Pede o MP4 (instrumental + letra) no tom escolhido. error: 'not_found' (música não existe) | 'not_ready'. */
    async requestExport(id, pitch, ctx = {}) {
      if (!(await describe(id, ctx))) return { error: 'not_found' };
      if (!(await isReady(id, ctx))) return { error: 'not_ready' };
      if ((await exportInfo(id, pitch, ctx)).status !== 'ready') await jobs.requestExport(id, pitch, { sessionId: ctx.sessionId ?? null });
      return { export: await exportInfo(id, pitch, ctx) };
    },

    /** Músicas prontas (metadados do meta.json): as do catálogo do dono, se a sessão tem armazenamento local; senão as do servidor. */
    async list(ctx = {}) {
      const lib = localOf(ctx);
      const local = lib ? agents.libraryList(lib.deviceId) : [];
      const metaKeys = (await storage.list('cache')).filter((key) => key.endsWith('/meta.json'));
      const songs = [];
      for (const key of metaKeys) {
        const id = key.split('/')[1];
        if (await cloudReady(id) && !local.some((song) => song.video_id === id)) songs.push(await readMeta(id));
      }
      return [...local, ...songs];
    },

    /**
     * Usa o cache se estiver pronto; senão cria um job (ou reaproveita o que está em andamento: dedupe).
     * `sessionId`: o job vai para o agente dono da sessão (sem ele, para o worker clássico).
     */
    async request(id, body = {}, { sessionId = null } = {}) {
      const explicitLyrics = body.lyrics && body.lyrics.source !== 'auto';
      const ctx = { sessionId };
      if ((await isReady(id, ctx)) && !explicitLyrics) {
        return { cached: true, created: false, deduped: false, song: await describe(id, ctx) };
      }
      // importada e fora da biblioteca: nenhum agente a baixaria (só o dono a tem, no computador dele)
      if (isImported(id)) return { error: 'imported_not_found' };
      await releaseStale(id, sessionId);
      const { created } = await jobs.enqueue(id, payloadFor(id, body), { replace: Boolean(explicitLyrics), sessionId });
      return { cached: false, created, deduped: !created, song: await describe(id, ctx) };
    },

    /** Escolhe/troca a letra (reaproveita o instrumental do cache). error: 'not_found' | 'in_progress'. */
    async setLyrics(id, lyrics, { artist, title } = {}, { sessionId = null } = {}) {
      const ctx = { sessionId };
      if (!(await describe(id, ctx))) return { error: 'not_found' };
      if (isImported(id)) return { error: 'imported' }; // a letra de uma importada se troca importando o arquivo de novo
      await releaseStale(id, sessionId);
      const { created } = await jobs.enqueue(id, payloadFor(id, { lyrics, artist, title }), { replace: true, sessionId });
      if (!created) return { error: 'in_progress' };
      return { song: await describe(id, ctx) };
    },
  };
}
