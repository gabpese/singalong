// Portão de ruído da voz: quando ninguém canta, o microfone só capta o ambiente (o ruído da sala, o restinho da música que
// o cancelamento de eco não tirou) e isso sai nas caixas como "eco" e chiado. O portão baixa o volume do microfone nesses
// momentos e o abre na hora em que a voz volta. Aqui só a decisão (abrir ou fechar); o motor de áudio aplica o ganho.

export const GATE = {
  openDb: -46, // acima disto (volume RMS do microfone, em dBFS) a voz entrou: o portão abre
  closeDb: -52, // abaixo disto o portão começa a fechar (a diferença evita abrir e fechar em volta do limite)
  holdMs: 280, // depois da última voz, espera isto antes de fechar (uma pausa entre palavras não corta a frase)
  floor: 0.12, // o portão fechado não calaria de vez: deixa passar um fiozinho (cortar de vez soa artificial)
  filterHz: 110, // filtro de graves: tira o ruído de manuseio e o estrondo do microfone
};

/** Volume RMS (0..1) em dBFS; silêncio total vale -Infinity. */
export const rmsToDb = (rms) => (rms > 0 ? 20 * Math.log10(rms) : -Infinity);

/** O volume RMS de um bloco de amostras. */
export function blockRms(samples) {
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

/** Um portão por microfone: `target(rms, nowMs)` devolve o ganho (1 = aberto, `floor` = fechado) para aquele instante. */
export function createGate(config = GATE) {
  let open = false;
  let lastLoud = -Infinity;
  return {
    target(rms, nowMs) {
      const db = rmsToDb(rms);
      if (db >= config.openDb) {
        open = true;
        lastLoud = nowMs;
      } else if (open && db >= config.closeDb) {
        lastLoud = nowMs; // ainda há voz fraca: mantém aberto
      } else if (open && nowMs - lastLoud > config.holdMs) {
        open = false;
      }
      return open ? 1 : config.floor;
    },
    get open() {
      return open;
    },
  };
}
