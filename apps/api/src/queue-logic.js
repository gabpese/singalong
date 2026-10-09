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
 * Ordem de execução do rodízio justo: uma música de cada pessoa por rodada, na ordem em que cada uma entrou na fila.
 * Quem cantou por último (`lastClientId`) fica no fim da primeira rodada, se houver outra pessoa esperando.
 * Dentro de cada pessoa vale a ordem da fila.
 */
export function fairOrder(queued, lastClientId = null) {
  const byClient = new Map();
  for (const item of queued) {
    if (!byClient.has(item.client_id)) byClient.set(item.client_id, []);
    byClient.get(item.client_id).push(item);
  }
  let clients = [...byClient.keys()];
  if (lastClientId && clients.length > 1 && byClient.has(lastClientId)) {
    clients = [...clients.filter((c) => c !== lastClientId), lastClientId];
  }
  const out = [];
  while (out.length < queued.length) {
    for (const c of clients) {
      const next = byClient.get(c).shift();
      if (next) out.push(next);
    }
  }
  return out;
}

/** Os itens na ordem em que vão tocar: a da fila, ou a do rodízio justo quando ligado. */
export function playOrder(queued, { fair = false, lastClientId = null } = {}) {
  return fair ? fairOrder(queued, lastClientId) : queued;
}

/**
 * Escolhe o próximo item a tocar.
 * - `queued`: itens na ordem da fila ({id, video_id, client_id}).
 * - `readyIds`: Set de video_id cujo processamento terminou. Itens ainda não prontos são PULADOS e mantêm a posição.
 * - `fair` (rodízio justo): segue a ordem de `fairOrder` (uma música de cada pessoa por rodada).
 */
export function nextPlayable(queued, readyIds, { fair = false, lastClientId = null } = {}) {
  return playOrder(queued, { fair, lastClientId }).find((item) => readyIds.has(item.video_id)) ?? null;
}

/** Id do vizinho com quem trocar de lugar ao mover `id` para cima/baixo (null nas pontas). */
export function swapTarget(orderedIds, id, direction) {
  const index = orderedIds.indexOf(id);
  if (index === -1) return null;
  const target = direction === 'up' ? index - 1 : index + 1;
  return orderedIds[target] ?? null;
}
