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

/**
 * Quando a linha termina de ser CANTADA. Letras com tempo só no início (LRC) marcam o fim de uma linha no começo da
 * seguinte, o que esconde solos e pausas dentro da linha anterior. Uma linha claramente longa demais para o seu texto
 * (mais de 1,5× a estimativa de ~0,12 s por letra + 2 s) é tratada como cantada na estimativa, seguida de silêncio.
 * Linhas com duração plausível mantêm o `end` original.
 */
export function sungEnd(cue) {
  const estimate = Math.max(3, 0.12 * (cue.text ?? '').length + 2);
  return cue.end - cue.start > estimate * 1.5 ? cue.start + estimate : cue.end;
}

/** Progresso (0..1) dentro da linha, para o preenchimento gradual do texto. */
export function lineProgress(cue, t) {
  const span = sungEnd(cue) - cue.start;
  if (span <= 0) return t >= cue.start ? 1 : 0;
  return Math.min(Math.max((t - cue.start) / span, 0), 1);
}

export const MIN_GAP_SECONDS = 8; // pausa a partir da qual o cantor recebe o aviso "prepare-se"
export const GAP_DASHES = 14; // tamanho do aviso: "--------------"
export const COUNTDOWN_SECONDS = 8; // os traços somem durante os últimos 8 s antes da próxima linha

/**
 * Se `t` está numa pausa de letra de 8 s ou mais (introdução, solo, ponte), devolve o aviso a mostrar:
 * { next: índice da próxima linha, remaining: segundos até ela, dashes: quantos traços mostrar }.
 * Os traços ficam completos e, nos últimos 8 s, vão sumindo: o cantor vê QUANDO a linha vai começar.
 * Devolve null fora de pausas longas, após a última linha (não há "próxima") e com letra vazia.
 */
export function gapDisplay(cues, t) {
  if (!cues.length) return null;
  let lo = 0;
  let hi = cues.length; // primeiro índice com start > t: a próxima linha
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) lo = mid + 1;
    else hi = mid;
  }
  if (lo >= cues.length) return null;
  const gapStart = lo === 0 ? 0 : sungEnd(cues[lo - 1]); // a introdução conta desde o início da música
  const gapEnd = cues[lo].start;
  if (t < gapStart || gapEnd - gapStart < MIN_GAP_SECONDS) return null;
  const remaining = gapEnd - t;
  const dashes = remaining >= COUNTDOWN_SECONDS ? GAP_DASHES : Math.max(1, Math.ceil((GAP_DASHES * remaining) / COUNTDOWN_SECONDS));
  return { next: lo, remaining, dashes };
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
 * Progresso (0..1) de cada palavra da linha no instante `t`, usando os tempos reais do alinhamento (`cue.words`).
 * Devolve null quando a linha não tem tempos por palavra (ou a contagem não bate): aí vale a estimativa por tamanho.
 */
export function wordFills(cue, wordCount, t) {
  const times = cue?.words;
  if (!Array.isArray(times) || times.length !== wordCount) return null;
  return times.map(([s, e]) => (e > s ? Math.min(Math.max((t - s) / (e - s), 0), 1) : t >= e ? 1 : 0));
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

/** Nível das vozes de apoio: inteiro de 0 a 100 (%); inválido = 0 (desligado). */
export function clampBacking(level) {
  const n = Math.round(Number(level));
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(n, 0), 100);
}

/** Limita o tom a ±6 semitons (acima disso o áudio degrada) e arredonda para inteiro. */
export function clampPitch(semitones) {
  const n = Math.round(Number(semitones));
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(n, PITCH_MIN), PITCH_MAX);
}
