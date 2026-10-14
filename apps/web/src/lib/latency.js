// Atraso do áudio na TV: o som demora para chegar aos ouvidos (caixa, Bluetooth, HDMI) e o microfone demora para entregar o que
// captou. Dois números, guardados neste aparelho (a TV):
//   output = quanto depois do que o motor toca o som é ouvido -> a letra mostra o que se OUVE agora (tempo da música - output);
//   input  = quanto depois de cantado o microfone entrega o som -> a pontuação compara a nota com a melodia de (tempo - output - input).

export const MAX_LATENCY_MS = 800;
const KEY = 'latency';

/** Inteiro de 0 a 800 ms; inválido = 0. */
export function clampLatency(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(n, 0), MAX_LATENCY_MS);
}

export function loadLatency() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return { output: clampLatency(saved.output), input: clampLatency(saved.input) };
  } catch {
    return { output: 0, input: 0 }; // sem armazenamento (ou fora do navegador)
  }
}

export function saveLatency({ output, input }) {
  const value = { output: clampLatency(output), input: clampLatency(input) };
  try {
    localStorage.setItem(KEY, JSON.stringify(value));
  } catch {
    // sem armazenamento: vale só até recarregar
  }
  return value;
}

/** A posição (s) da música que a pessoa ouve agora, dada a que o motor está tocando. */
export const heardPosition = (position, outputMs) => Math.max(0, position - clampLatency(outputMs) / 1000);

/** A posição (s) da música que o microfone está entregando agora (o que foi cantado há `output + input` ms). */
export const sungPosition = (position, { output, input }) => Math.max(0, position - (clampLatency(output) + clampLatency(input)) / 1000);

/**
 * Instantes (s) em que o som "estoura" numa gravação: o primeiro ponto em que o volume passa de `threshold` vezes o pico mais alto,
 * com pelo menos `minGapMs` entre um e outro (o eco do mesmo estalo não conta duas vezes).
 */
export function detectOnsets(samples, sampleRate, { threshold = 0.35, minGapMs = 300, minPeak = 0.02 } = {}) {
  let peak = 0;
  for (let i = 0; i < samples.length; i++) peak = Math.max(peak, Math.abs(samples[i]));
  if (peak < minPeak) return []; // nada foi ouvido
  const limit = peak * threshold;
  const gap = Math.round((minGapMs / 1000) * sampleRate);
  const onsets = [];
  let blockedUntil = 0;
  for (let i = 0; i < samples.length; i++) {
    if (i < blockedUntil || Math.abs(samples[i]) < limit) continue;
    onsets.push(i / sampleRate);
    blockedUntil = i + gap;
  }
  return onsets;
}

/**
 * O atraso (ms) entre os estalos tocados (`clickTimes`, s) e os ouvidos no microfone (`onsets`, s): a mediana, entre os estalos,
 * da distância até o primeiro som que chegou depois dele (até `maxMs`). null se menos de 3 estalos foram ouvidos.
 */
export function estimateDelay(clickTimes, onsets, { maxMs = MAX_LATENCY_MS, minHits = 3 } = {}) {
  const delays = [];
  for (const click of clickTimes) {
    const heard = onsets.find((onset) => onset >= click - 0.01 && onset <= click + maxMs / 1000);
    if (heard !== undefined) delays.push((heard - click) * 1000);
  }
  if (delays.length < minHits) return null;
  delays.sort((a, b) => a - b);
  return Math.round(delays[delays.length >> 1]);
}

/**
 * Separa o atraso medido (ida e volta: saída + entrada) nos dois números: `outputMs` é o que o navegador informa da saída
 * (ou o que a pessoa já ajustou); o resto é da entrada.
 */
export function splitRoundTrip(roundTripMs, outputMs) {
  const output = Math.min(clampLatency(outputMs), clampLatency(roundTripMs));
  return { output, input: clampLatency(roundTripMs) - output };
}
