// Pontuação por afinação: compara o tom captado no microfone com a melodia da voz original (melody.json do worker).

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
/** "A4" para a nota MIDI 69 (ou "—" sem nota). */
export const noteName = (midi) => (midi == null || midi < 0 ? '—' : `${NAMES[((Math.round(midi) % 12) + 12) % 12]}${Math.floor(Math.round(midi) / 12) - 1}`);

export const hzToMidi = (hz) => 69 + 12 * Math.log2(hz / 440);

/** Volume (RMS) de um bloco de áudio. */
export function rms(buf) {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  return Math.sqrt(sum / buf.length);
}

/**
 * Frequência fundamental (Hz) de um bloco de áudio pelo método YIN, ou null se não houver tom claro.
 * O bloco precisa ter pelo menos 2 períodos do tom mais grave (2048 amostras servem para 70 Hz a 48 kHz).
 */
export function detectPitch(buf, sampleRate, { minHz = 70, maxHz = 1000, threshold = 0.15 } = {}) {
  const half = buf.length >> 1;
  const tauMin = Math.max(2, Math.floor(sampleRate / maxHz));
  const tauMax = Math.min(Math.floor(sampleRate / minHz), half - 1);
  if (tauMax <= tauMin) return null;
  const cmnd = new Float32Array(tauMax + 1);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= tauMax; tau++) {
    let d = 0;
    for (let i = 0; i < half; i++) {
      const delta = buf[i] - buf[i + tau];
      d += delta * delta;
    }
    running += d;
    cmnd[tau] = running ? (d * tau) / running : 1;
  }
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (cmnd[tau] >= threshold) continue;
    while (tau + 1 <= tauMax && cmnd[tau + 1] < cmnd[tau]) tau++; // desce até o mínimo local
    const a = cmnd[tau - 1];
    const b = cmnd[tau];
    const c = cmnd[tau + 1] ?? b;
    const denom = a - 2 * b + c;
    const shift = denom ? (a - c) / (2 * denom) : 0; // interpolação parabólica: precisão menor que uma amostra
    return sampleRate / (tau + shift);
  }
  return null;
}

/** Distância em semitones entre duas notas, ignorando a oitava (quem canta uma oitava acima ou abaixo também acerta). */
export function pitchClassDistance(a, b) {
  const d = (((a - b) % 12) + 12) % 12;
  return Math.min(d, 12 - d);
}

const FULL = 1; // semitones de tolerância para o acerto inteiro (voz humana oscila: vibrato, escorregadas)
const HALF = 2; // ...e para meio acerto
const WINDOW_FRAMES = 40; // a nota vale por trechos de 2 s: a melodia original muda várias vezes por segundo e ninguém acompanha cada troca
const WINDOW_FULL = 0.7; // trecho em que 70% ou mais das notas detectadas estão certas conta inteiro
const WINDOW_HALF = 0.45; // ...com 45% ou mais, conta metade
// O detector de tom falha em muitos quadros de uma voz real (consoantes, respiração, voz fraca). Por isso a nota separa
// "estava cantando?" (quadros com tom detectado) de "estava no tom?" (acertos entre os detectados): detectar em 40% dos
// quadros com voz já é participação total, e a falha do detector não vira erro do cantor.
const PARTICIPATION_FULL = 0.4
const HOLD_SECONDS = 0.15; // o detector falha em consoantes e respirações: vale a última nota captada há menos de 150 ms
const LAG_FRAMES = 2; // a nota cantada pode vir até 100 ms depois da de referência (ouvir, cantar, captar) ...
const LEAD_FRAMES = 2; // ...ou 100 ms antes. Folga maior faz qualquer nota acertar alguma da melodia, que varia várias vezes por segundo

/**
 * Acompanha a música quadro a quadro (50 ms). `melody` = { hop, midi: [nota | -1] }; `transpose` = tom escolhido (semitones).
 * Só contam os quadros em que a voz original canta; quadros já avaliados (seek para trás) não contam duas vezes.
 * Os quadros se agrupam em trechos de 2 s, e cada trecho vale pela fração de acertos dele (ver WINDOW_*).
 */
export function createScorer(melody, { transpose = 0 } = {}) {
  const { hop, midi } = melody;
  let shift = transpose;
  const seen = new Uint8Array(midi.length);
  let counted = 0;
  let heldNote = null;
  let heldAt = -Infinity;
  let reference = null; // nota de referência do quadro atual, já no tom escolhido
  const windows = new Map(); // trecho -> { n: quadros com voz no original, heard: quadros com tom detectado, hit: pontos de acerto }

  return {
    /** t = posição da música (s); sung = nota MIDI captada no microfone (ou null: silêncio). Devolve a nota ao vivo (0..100) ou null. */
    tick(t, captured) {
      if (captured != null) {
        heldNote = captured;
        heldAt = t;
      }
      const sung = captured ?? (t - heldAt <= HOLD_SECONDS && t >= heldAt ? heldNote : null);
      const idx = Math.floor(t / hop);
      reference = midi[idx] >= 0 ? midi[idx] + shift : null;
      if (idx < 0 || idx >= midi.length || seen[idx]) return this.score();
      seen[idx] = 1;
      if (midi[idx] < 0) return this.score(); // sem voz no original: nada a avaliar
      counted++;
      const win = windows.get(Math.floor(idx / WINDOW_FRAMES)) ?? { n: 0, heard: 0, hit: 0 };
      windows.set(Math.floor(idx / WINDOW_FRAMES), win);
      win.n++;
      if (sung != null) {
        win.heard++;
        let best = Infinity;
        for (let j = idx - LAG_FRAMES; j <= idx + LEAD_FRAMES; j++) {
          if (midi[j] >= 0) best = Math.min(best, pitchClassDistance(sung, midi[j] + shift));
        }
        win.hit += best <= FULL ? 1 : best <= HALF ? 0.5 : 0;
      }
      return this.score();
    },
    /** O tom pode mudar no meio da música: a melodia de referência acompanha. */
    setTranspose(semitones) { shift = semitones; },
    /** Nota 0..100 (null enquanto não houve nenhum quadro avaliado). */
    score() {
      if (!counted) return null;
      let points = 0;
      for (const { n, heard, hit } of windows.values()) {
        if (!heard) continue;
        const accuracy = hit / heard;
        const participation = Math.min(1, heard / n / PARTICIPATION_FULL);
        points += n * participation * (accuracy >= WINDOW_FULL ? 1 : accuracy >= WINDOW_HALF ? 0.5 : 0);
      }
      return Math.round((100 * points) / counted);
    },
    get reference() { return reference; },
    get evaluated() { return counted; },
  };
}

/** Abre o microfone. Devolve { read(), stop() }; `read()` = { midi: nota | null, level }. Lança se a pessoa negar o acesso. */
export async function openMic() {
  const stream = await navigator.mediaDevices.getUserMedia({
    // cancelar o eco evita que o instrumental da própria TV conte como voz
    audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
  });
  const ctx = new AudioContext();
  await ctx.resume();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 2048;
  ctx.createMediaStreamSource(stream).connect(analyser);
  const buf = new Float32Array(analyser.fftSize);
  return {
    read() {
      analyser.getFloatTimeDomainData(buf);
      const level = rms(buf);
      if (level < 0.005) return { midi: null, level }; // silêncio
      const hz = detectPitch(buf, ctx.sampleRate);
      return { midi: hz ? hzToMidi(hz) : null, level };
    },
    stop() {
      for (const track of stream.getTracks()) track.stop();
      ctx.close();
    },
  };
}
