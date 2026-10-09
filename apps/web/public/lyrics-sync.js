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

/**
 * O foco está num controle que usa essas teclas por conta própria (campo de texto, lista, botão)?
 * Os atalhos globais (Espaço, setas, F) não devem roubar a digitação nem o clique nativo.
 * `target` só precisa de tagName/type/isContentEditable (aceita um objeto simples nos testes).
 */
export function isTypingTarget(target) {
  if (!target) return false;
  const tag = String(target.tagName ?? '').toUpperCase();
  if (tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || target.isContentEditable) return true;
  if (tag === 'INPUT') return !['range', 'checkbox', 'radio'].includes(String(target.type ?? 'text').toLowerCase());
  return false;
}

/**
 * Parece um link do YouTube (ou um ID de 11 caracteres)? Qualquer outra coisa é tratada como pesquisa.
 * Uma palavra de 11 letras (ex.: "Bohemian...") também casa com o ID: o servidor valida de verdade.
 */
export function looksLikeLink(value) {
  const v = String(value ?? '').trim();
  return /^[\w-]{11}$/.test(v) || /^(https?:\/\/)?([\w-]+\.)?(youtube\.com|youtu\.be)\//i.test(v);
}

const LYRICS_SOURCES = {
  video: 'legenda do vídeo',
  lrclib: 'buscada na internet',
  file: 'colada, com tempos',
  align: 'seu texto, sincronizado com a voz por IA',
  'lrclib+align': 'buscada na internet, sincronizada com a voz por IA',
  none: 'sem letra (só o instrumental)',
};

/** Texto amigável para o `lyrics_source` do meta.json (ex.: "text+lrclib"). */
export function describeLyricsSource(source) {
  if (!source) return 'desconhecida';
  if (source.startsWith('text+')) {
    const donor = source.slice('text+'.length);
    return `seu texto, com os tempos ${donor === 'video' ? 'da legenda do vídeo' : 'da busca na internet'}`;
  }
  return LYRICS_SOURCES[source] ?? source;
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
