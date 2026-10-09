// Textos e cálculos de exibição da fila (puro, sem DOM).

const STAGES = {
  downloading: 'Baixando o áudio…',
  separating: 'Separando a voz…',
  lyrics: 'Buscando a letra…',
  aligning: 'Sincronizando a letra…',
};

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

/** Item que está tocando e os que aguardam, a partir do estado da sala. */
export function splitQueue(state) {
  const current = state?.queue?.find((item) => item.id === state.current_item_id) ?? null;
  return { current, waiting: (state?.queue ?? []).filter((item) => item.id !== current?.id) };
}
