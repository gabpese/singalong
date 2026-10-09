// Lógica pura de sincronia da letra (sem DOM), testável em Node.

/**
 * Localiza a linha ativa no tempo `t` (segundos).
 * `cues` = [{start, end, text}] ordenado por `start`.
 * - current: índice da linha cantada agora, ou -1 (antes da primeira linha ou num intervalo)
 * - next: índice da próxima linha a cantar (ou cues.length se não há mais)
 */
export function locate(cues, t) {
  let lo = 0;
  let hi = cues.length; // primeiro índice com start > t
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) lo = mid + 1;
    else hi = mid;
  }
  const last = lo - 1;
  if (last >= 0 && t < cues[last].end) return { current: last, next: last + 1 };
  return { current: -1, next: lo };
}

/** Progresso (0..1) dentro da linha, para o preenchimento gradual do texto. */
export function lineProgress(cue, t) {
  const span = cue.end - cue.start;
  if (span <= 0) return t >= cue.start ? 1 : 0;
  return Math.min(Math.max((t - cue.start) / span, 0), 1);
}

/**
 * Divide a frase em palavras e calcula em que fração (0..1) da linha cada uma começa e termina,
 * proporcional ao número de caracteres (espaços incluídos). Permite preencher na ordem de leitura,
 * independentemente de onde a linha quebre na tela.
 */
export function wordSpans(text) {
  const total = text.length;
  if (!total) return [];
  const spans = [];
  for (const m of text.matchAll(/\S+/g)) {
    spans.push({ word: m[0], from: m.index / total, to: (m.index + m[0].length) / total });
  }
  return spans;
}

/** Progresso (0..1) de uma palavra dado o progresso (0..1) da linha. */
export function wordProgress(span, lineP) {
  const width = span.to - span.from;
  if (width <= 0) return lineP >= span.to ? 1 : 0;
  return Math.min(Math.max((lineP - span.from) / width, 0), 1);
}

export const PITCH_MIN = -6;
export const PITCH_MAX = 6;

/** Limita o tom a ±6 semitons (acima disso o áudio degrada) e arredonda para inteiro. */
export function clampPitch(semitones) {
  const n = Math.round(Number(semitones));
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(n, PITCH_MIN), PITCH_MAX);
}

export function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
