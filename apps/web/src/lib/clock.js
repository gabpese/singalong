// Relógio do palco (celular): a TV é quem toca a música e informa a posição a cada segundo; entre uma mensagem e outra o
// relógio anda sozinho. Cada mensagem chega com um atraso desconhecido, então vale a MENOR diferença entre o relógio local e o
// da música nas últimas mensagens (a que menos atrasou): o erro cai para algumas dezenas de milissegundos.

/**
 * @param now         relógio local em ms (injetável nos testes)
 * @param windowSize  quantas mensagens recentes entram na estimativa
 * @param jump        diferença (s) a partir da qual entende que houve um salto (a música pulou ou voltou de uma pausa)
 */
export function createSyncClock({ now = () => performance.now(), windowSize = 8, jump = 1.5 } = {}) {
  let samples = []; // instante local (s) em que a música estaria no segundo 0, segundo cada mensagem
  let start = null; // a melhor estimativa dele
  let frozen = 0; // posição (s) enquanto pausado
  let playing = false;
  const local = () => now() / 1000;

  return {
    /** A TV informou que a música está em `ms` agora. */
    position(ms) {
      const t = Math.max(0, Number(ms) || 0) / 1000;
      const sample = local() - t;
      if (start !== null && Math.abs(sample - start) > jump) samples = []; // salto: as amostras antigas não valem mais
      samples.push(sample);
      if (samples.length > windowSize) samples.shift();
      start = Math.min(...samples);
      frozen = t;
    },

    /** A sala está tocando ou pausada. Ao pausar, congela onde estava; ao retomar, segue dali até a próxima mensagem da TV. */
    setPlaying(value) {
      if (Boolean(value) === playing) return;
      if (!value && start !== null) frozen = local() - start;
      if (value) {
        start = local() - frozen;
        samples = [start];
      }
      playing = Boolean(value);
    },

    /** Música nova (ou saiu do palco): esquece tudo. */
    reset() {
      samples = [];
      start = null;
      frozen = 0;
      playing = false;
    },

    /** A posição da música agora, em segundos. */
    time() {
      if (!playing || start === null) return frozen;
      return Math.max(0, local() - start);
    },

    get playing() {
      return playing;
    },
  };
}
