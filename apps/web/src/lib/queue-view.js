// Textos e cálculos de exibição da fila (puro, sem DOM).

const STAGES = {
  downloading: 'Baixando o áudio…',
  separating: 'Separando a voz…',
  lyrics: 'Buscando a letra…',
  aligning: 'Sincronizando a letra…',
  retrying: 'Tentando de novo…',
};

/** Vale oferecer "Tentar de novo"? Não quando o erro é definitivo (vídeo privado, bloqueado, longo demais...). */
export function canRetry(song) {
  return song?.status === 'failed' && song.retry !== 'never';
}

/** Etiqueta do estado de uma música na fila: { label, kind } com kind = ok | busy | warn | error. */
export function songChip(song) {
  if (!song) return { label: 'Aguardando', kind: 'busy' };
  if (song.status === 'needs_lyrics') return { label: 'Precisa de letra', kind: 'warn' };
  if (song.status === 'failed') return { label: 'Falhou', kind: 'error' };
  if (song.status === 'pending') return { label: 'Na fila de processamento', kind: 'busy' };
  if (song.status === 'processing') return { label: STAGES[song.stage] ?? 'Processando…', kind: 'busy' };
  if (song.ready) return { label: 'Pronta', kind: 'ok' };
  return { label: 'Aguardando', kind: 'busy' };
}

export function formatDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const thumbnailUrl = (videoId) => `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;

/** Porcentagem (0..100) tocada; 0 se a duração é desconhecida. */
export function progressPercent(positionMs, durationSeconds) {
  if (!durationSeconds) return 0;
  return Math.min(100, Math.max(0, (positionMs / 1000 / durationSeconds) * 100));
}

/** "+3", "-2" ou "0": o tom como a pessoa lê. */
export function formatPitch(semitones) {
  return semitones > 0 ? `+${semitones}` : String(semitones);
}

/**
 * Quem canta a seguir: o item que o servidor escolheu (pronto, respeitando o rodízio justo); se nenhum está pronto,
 * o primeiro da fila de espera, marcado como "ainda preparando".
 */
export function nextUp(state) {
  const { waiting } = splitQueue(state);
  const chosen = waiting.find((item) => item.id === state?.next_item_id);
  if (chosen) return { item: chosen, preparing: false };
  return waiting.length ? { item: waiting[0], preparing: true } : null;
}

/**
 * O que toca e o que vem depois, na ORDEM EM QUE VAI TOCAR: o próximo que o servidor escolheu (pronto, respeitando o
 * rodízio justo) vem na frente; o resto segue a ordem da fila.
 */
export function playOrder(state) {
  const { current, waiting } = splitQueue(state);
  if (Array.isArray(state?.play_order)) {
    const byId = new Map(waiting.map((item) => [item.id, item]));
    const ordered = state.play_order.map((id) => byId.get(id)).filter(Boolean);
    return { current, upcoming: [...ordered, ...waiting.filter((item) => !ordered.includes(item))] };
  }
  const next = waiting.find((item) => item.id === state?.next_item_id);
  return { current, upcoming: next ? [next, ...waiting.filter((item) => item !== next)] : waiting };
}

/** Item que está tocando e os que aguardam, a partir do estado da sala. */
export function splitQueue(state) {
  const current = state?.queue?.find((item) => item.id === state.current_item_id) ?? null;
  return { current, waiting: (state?.queue ?? []).filter((item) => item.id !== current?.id) };
}

/** Minúsculas e sem acentos: "Ré", "RE" e "re" são a mesma coisa para quem está procurando. */
export function normalizeText(value) {
  return String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Filtra as músicas já processadas por artista e nome. Cada palavra digitada precisa aparecer em algum dos dois, em
 * qualquer ordem ("elfman jack" acha "Jack's Lament — Danny Elfman"). Consulta vazia devolve tudo.
 */
export function filterSongs(songs, query) {
  const terms = normalizeText(query).split(' ').filter(Boolean);
  if (!terms.length) return songs;
  return songs.filter((song) => {
    const haystack = normalizeText(`${song.artist ?? ''} ${song.title ?? ''} ${song.video_title ?? ''}`);
    return terms.every((term) => haystack.includes(term));
  });
}

/** Palavras de um texto para comparar versões: sem acento, maiúsculas, apóstrofos nem pontuação ("Don't Stop!" -> dont, stop). */
function words(value) {
  return normalizeText(value).replace(/['’`]/g, '').split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Músicas já prontas (o "Jukebox") que são a que a pessoa está pedindo: TODAS as palavras do artista e do nome digitados
 * aparecem, inteiras, no artista, no título ou no TÍTULO ORIGINAL DO VÍDEO do YouTube (`video_title`): quem deu outro nome à
 * música ao pedi-la ainda a encontra pelo que o vídeo se chama ("Faouzia - Unethical (MAPHRA Vocal Cover)" é achada por
 * Maphra + Unethical). Sem artista ou sem nome, não sugere nada (seria só palpite).
 */
export function findJukeboxMatches(songs, artist, title) {
  const wanted = [...new Set([...words(artist), ...words(title)])];
  if (!words(artist).length || !words(title).length) return [];
  return sortSongs(
    songs.filter((song) => {
      const have = new Set([...words(song.artist), ...words(song.title), ...words(song.video_title)]);
      return wanted.every((word) => have.has(word));
    }),
  );
}

/** Ordem alfabética por artista e depois por nome; as sem artista vão para o fim (também em ordem alfabética). */
export function sortSongs(songs) {
  const collator = new Intl.Collator('pt-BR', { sensitivity: 'base' });
  return [...songs].sort((a, b) => {
    const artistA = normalizeText(a.artist);
    const artistB = normalizeText(b.artist);
    if (artistA !== artistB && (!artistA || !artistB)) return artistA ? -1 : 1; // quem não tem artista fica por último
    return collator.compare(artistA, artistB) || collator.compare(normalizeText(a.title), normalizeText(b.title));
  });
}
