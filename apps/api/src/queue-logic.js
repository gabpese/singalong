// Regras puras da fila (sem I/O), testáveis isoladamente.

export const PITCH_MIN = -6;
export const PITCH_MAX = 6;

/** Tom em semitons: inteiro entre -6 e +6 (acima disso o áudio degrada). Valores inválidos viram 0. */
export function clampPitch(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(n, PITCH_MIN), PITCH_MAX);
}

/** Ajuste da letra em segundos, limitado a ±10 s e a 2 casas. */
export function clampOffset(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(Math.min(Math.max(n, -10), 10) * 100) / 100;
}

/**
 * Escolhe o próximo item a tocar.
 * - `queued`: itens na ordem da fila ({id, video_id, client_id}).
 * - `readyIds`: Set de video_id cujo processamento terminou. Itens ainda não prontos são PULADOS e mantêm a posição.
 * - `fair` (rodízio justo): evita a mesma pessoa duas vezes seguidas quando há outra pessoa com música pronta.
 */
export function nextPlayable(queued, readyIds, { fair = false, lastClientId = null } = {}) {
  const playable = queued.filter((item) => readyIds.has(item.video_id));
  if (!playable.length) return null;
  if (!fair || !lastClientId) return playable[0];
  return playable.find((item) => item.client_id !== lastClientId) ?? playable[0];
}

/** Id do vizinho com quem trocar de lugar ao mover `id` para cima/baixo (null nas pontas). */
export function swapTarget(orderedIds, id, direction) {
  const index = orderedIds.indexOf(id);
  if (index === -1) return null;
  const target = direction === 'up' ? index - 1 : index + 1;
  return orderedIds[target] ?? null;
}
