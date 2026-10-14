// Guia de melodia na TV: as notas da voz original como barras que andam para a esquerda, com a afinação de quem canta por cima.
// Aqui só a parte sem desenho (notas, janela de tempo, escala vertical, oitava e acerto), para testar em Node.
import { pitchClassDistance, smoothMelody } from './scoring.js';

/** Quanto da música aparece na tela: um pouco do que passou e bastante do que vem (para a pessoa se preparar). */
export const SECONDS_BEFORE = 2;
export const SECONDS_AFTER = 6;
/** A faixa vertical mostra pelo menos uma oitava; `PAD` semitons de folga acima e abaixo das notas. */
const MIN_SPAN = 12;
const PAD = 2;
/** Até quantos semitons de distância (sem oitava) a nota cantada ainda conta como "no tom". */
export const GOOD_DISTANCE = 1;
/** As cores das partes do dueto no guia (as mesmas da letra: turquesa, violeta e, juntos, o amarelo do tema). */
export const PART_COLORS = { a: '#10B8C8', b: '#8B5CF6' };

/** Quanto tempo a trilha do que foi cantado fica na tela (s). */
export const TRAIL_SECONDS = 3;

/** @typedef {{ start: number, end: number, note: number }} MelodyNote */

/**
 * As notas estáveis da melodia: trechos contínuos da mesma nota (a melodia já suavizada, a mesma que a pontuação usa).
 * @param {{ hop: number, midi: number[] }} melody
 * @returns {Array<{ start: number, end: number, note: number }>} tempos em segundos, `note` = nota MIDI inteira
 */
export function melodyNotes(melody) {
  if (!melody?.hop || !Array.isArray(melody.midi)) return [];
  const midi = smoothMelody(melody.midi);
  const notes = [];
  let i = 0;
  while (i < midi.length) {
    if (midi[i] < 0) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < midi.length && midi[j + 1] === midi[i]) j++;
    notes.push({ start: i * melody.hop, end: (j + 1) * melody.hop, note: midi[i] });
    i = j + 1;
  }
  return notes;
}

/** As notas que aparecem (mesmo em parte) entre `from` e `to` segundos. */
export function notesInWindow(notes, from, to) {
  return notes.filter((n) => n.end > from && n.start < to);
}

/** A nota (no tom escolhido) que a original canta no instante `t`, ou null. */
export function noteAt(notes, t, transpose = 0) {
  const found = notes.find((n) => n.start <= t && t < n.end);
  return found ? found.note + transpose : null;
}

/** A faixa vertical { low, high } (MIDI) que cobre as notas da janela, com folga e no mínimo uma oitava. */
export function pitchRange(visible, transpose = 0) {
  if (!visible.length) return null;
  let low = Infinity;
  let high = -Infinity;
  for (const n of visible) {
    low = Math.min(low, n.note + transpose);
    high = Math.max(high, n.note + transpose);
  }
  low -= PAD;
  high += PAD;
  if (high - low < MIN_SPAN) {
    const extra = (MIN_SPAN - (high - low)) / 2;
    low -= extra;
    high += extra;
  }
  return { low, high };
}

/** Suaviza a faixa de um quadro para o outro (a escala vertical não pula quando uma nota alta entra na janela). */
export function easeRange(current, target, factor = 0.08) {
  if (!target) return current;
  if (!current) return target;
  return { low: current.low + (target.low - current.low) * factor, high: current.high + (target.high - current.high) * factor };
}

/** A nota cantada na oitava mais perto da de referência: quem canta uma oitava acima ou abaixo também aparece junto da barra. */
export function foldToNearestOctave(sung, reference) {
  if (sung == null || reference == null) return sung;
  return sung + 12 * Math.round((reference - sung) / 12);
}

/** O que foi cantado contou como "no tom" para a nota de referência (sem olhar a oitava)? */
export function isGood(sung, reference) {
  return sung != null && reference != null && pitchClassDistance(sung, reference) <= GOOD_DISTANCE;
}

/** Converte tempo em x e nota em y num quadro de `width` x `height`; o "agora" fica a 1/4 da esquerda. */
export function makeScale({ position, width, height, range }) {
  const span = SECONDS_BEFORE + SECONDS_AFTER;
  const perSecond = width / span;
  const semitone = range ? height / (range.high - range.low) : 0;
  return {
    x: (t) => (t - position + SECONDS_BEFORE) * perSecond,
    y: (note) => (range ? height - (note - range.low) * semitone : height / 2),
    barHeight: Math.max(6, semitone * 0.8),
    nowX: SECONDS_BEFORE * perSecond,
  };
}

/** Acrescenta uma leitura à trilha e descarta o que ficou velho demais (`t` em segundos da música). */
export function pushTrail(trail, point, keepSeconds = TRAIL_SECONDS) {
  const next = [...trail, point];
  const cut = point.t - keepSeconds;
  return next.filter((p) => p.t >= cut);
}
