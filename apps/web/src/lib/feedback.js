// Detector de microfonia (o apito): quando o som da caixa volta ao microfone e se realimenta, aparece no espectro um pico
// estreito, de um tom só, que fica na mesma frequência e CRESCE. Uma voz cantada também sustenta uma nota, mas tem harmónicos e
// oscila; o apito é um tom puro que sobe sem parar. Ao detectar, a guarda corta o volume da voz pela metade (e de novo, se
// continuar) e depois o devolve devagar, sem passar do ponto em que o apito apareceu.
//
// Trabalha com o espectro em dB (o que o AnalyserNode entrega), quadro a quadro, e não conhece o Web Audio: dá para testar em Node.

export const FEEDBACK = {
  minHz: 200, // abaixo disso há ruído de manuseio; acima de maxHz, quase nada de voz
  maxHz: 8000,
  minLevelDb: -50, // pico mais fraco que isso não é apito
  prominenceDb: 25, // quanto o pico se destaca da mediana do espectro
  sidesDb: 12, // quanto os vizinhos (±3 bins) ficam abaixo do pico: um tom estreito
  harmonicsDb: 10, // 2º e 3º harmónicos pelo menos tanto abaixo do pico (voz tem harmónicos fortes; o apito é quase puro)
  persistMs: 300, // o pico fica na mesma frequência por pelo menos isso...
  growthDb: 4, // ...e cresce pelo menos isso
  loudPersistMs: 800, // ou fica quase fixo, muito forte, por mais tempo
  loudProminenceDb: 35,
  cut: 0.5, // cada detecção corta o ganho pela metade
  minFactor: 0.05,
  recoverAfterMs: 3000, // sem apito por esse tempo, o volume volta
  recoverPerSecond: 0.15, // 15 % por segundo
  ceilingMargin: 0.8, // volta no máximo a 80 % do ganho em que o apito apareceu
  ceilingForgetMs: 60_000, // depois de um minuto sem apito, o limite é esquecido
};

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
};

/** O pico de um tom só, se houver: { bin, level, prominence } ou null. */
export function findTonalPeak(spectrumDb, sampleRate, config = FEEDBACK) {
  const binHz = sampleRate / (spectrumDb.length * 2);
  const lo = Math.max(4, Math.ceil(config.minHz / binHz));
  const hi = Math.min(spectrumDb.length - 5, Math.floor(config.maxHz / binHz));
  if (hi <= lo) return null;
  let peak = lo;
  for (let i = lo; i <= hi; i++) if (spectrumDb[i] > spectrumDb[peak]) peak = i;
  const level = spectrumDb[peak];
  if (!(level > config.minLevelDb)) return null;
  const prominence = level - median(Array.from(spectrumDb.slice(lo, hi + 1)));
  if (prominence < config.prominenceDb) return null;
  // estreito: os vizinhos a 3 bins dos dois lados ficam bem abaixo
  if (spectrumDb[peak - 3] > level - config.sidesDb || spectrumDb[peak + 3] > level - config.sidesDb) return null;
  // quase puro: os harmónicos (quando cabem no espectro) ficam bem abaixo
  for (const k of [2, 3]) {
    const harmonic = peak * k;
    if (harmonic + 1 >= spectrumDb.length) continue;
    const around = Math.max(spectrumDb[harmonic - 1], spectrumDb[harmonic], spectrumDb[harmonic + 1]);
    if (around > level - config.harmonicsDb) return null;
  }
  return { bin: peak, level, prominence };
}

/**
 * A guarda: recebe um espectro por quadro e devolve o fator (0..1) que multiplica o volume da voz.
 * @returns {{ update(spectrumDb: Float32Array | number[], nowMs: number, sampleRate: number): { factor: number, triggered: boolean, hz: number | null }, factor: number, reset(): void }}
 */
export function createFeedbackGuard(config = FEEDBACK) {
  let factor = 1;
  let ceiling = 1;
  let ceilingAt = -Infinity;
  let history = []; // { t, bin, level } do mesmo pico
  let lastTrigger = -Infinity;
  let lastUpdate = null;

  return {
    update(spectrumDb, nowMs, sampleRate) {
      const dt = lastUpdate === null ? 0 : Math.max(0, nowMs - lastUpdate) / 1000;
      lastUpdate = nowMs;
      const peak = findTonalPeak(spectrumDb, sampleRate, config);
      let triggered = false;
      let hz = null;

      if (peak) {
        const last = history[history.length - 1];
        if (!last || Math.abs(peak.bin - last.bin) <= 1) history.push({ t: nowMs, bin: peak.bin, level: peak.level, prominence: peak.prominence });
        else history = [{ t: nowMs, bin: peak.bin, level: peak.level, prominence: peak.prominence }];
        const first = history[0];
        const span = nowMs - first.t;
        const growth = peak.level - first.level;
        const growing = span >= config.persistMs && growth >= config.growthDb;
        const loudAndFixed = span >= config.loudPersistMs && peak.prominence >= config.loudProminenceDb && growth >= -1;
        if (growing || loudAndFixed) {
          triggered = true;
          hz = Math.round((peak.bin * sampleRate) / (spectrumDb.length * 2));
          ceiling = Math.max(config.minFactor, factor * config.ceilingMargin);
          ceilingAt = nowMs;
          factor = Math.max(config.minFactor, factor * config.cut);
          lastTrigger = nowMs;
          history = [];
        }
      } else {
        history = [];
      }

      if (nowMs - ceilingAt > config.ceilingForgetMs) ceiling = 1;
      if (!triggered && factor < ceiling && nowMs - lastTrigger >= config.recoverAfterMs) {
        factor = Math.min(ceiling, factor * (1 + config.recoverPerSecond * dt));
      }
      return { factor, triggered, hz };
    },
    get factor() {
      return factor;
    },
    reset() {
      factor = 1;
      ceiling = 1;
      history = [];
      lastTrigger = -Infinity;
      lastUpdate = null;
    },
  };
}
