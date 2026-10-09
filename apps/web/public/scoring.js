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

// Crédito pela distância (em semitones, sem oitava) entre a nota cantada e a principal da original: cai aos poucos, porque
// 2 ou 3 semitons de erro ainda é "quase" para uma voz humana (vibrato, escorregadas, nota imprecisa).
const CREDIT_BY_DISTANCE = [1, 1, 0.8, 0.5]; // 0, 1, 2 e 3 semitons; mais que isso não pontua
const creditFor = (distance) => CREDIT_BY_DISTANCE[distance] ?? 0;
const BLOCK_SECONDS = 2; // a nota é conferida uma vez a cada 2 s: a melodia original muda várias vezes por segundo e ninguém acompanha cada troca
const MAIN_SHARE = 0.4; // notas que a original sustenta por pelo menos 40% do bloco são as "principais" dele
const MIN_REF_FRAMES = 10; // bloco com menos de 0,5 s de voz na original não é cobrado
// O detector de tom falha em muitos quadros de uma voz real (consoantes, respiração, voz fraca). Por isso a nota separa
// "estava cantando?" (quadros com tom detectado) de "estava no tom?" (a nota mais cantada do bloco): detectar em 40% dos
// quadros com voz já é participação total, e a falha do detector não vira erro do cantor.
const PARTICIPATION_FULL = 0.4;
const HOLD_SECONDS = 0.15; // o detector falha em consoantes e respirações: vale a última nota captada há menos de 150 ms

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1];
};

/**
 * Transforma a melodia crua (que oscila vários quadros por segundo: vibrato, escorregadas, erros do detector) em notas
 * estáveis: mediana de ±2 quadros, depois trechos contínuos de notas a até 1 semitom uns dos outros viram uma nota só
 * (a mediana deles), e trechos com menos de `minFrames` quadros (0,3 s) são absorvidos pelo vizinho mais próximo.
 */
export function smoothMelody(midi, { minFrames = 6 } = {}) {
  const n = midi.length;
  const filtered = midi.map((m, i) => {
    if (m < 0) return -1;
    const near = [];
    for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) if (midi[j] >= 0) near.push(midi[j]);
    return median(near);
  });
  // trechos de voz contínua, divididos quando a nota se afasta mais de 1 semitom da mediana do trecho
  const segments = []; // { from, to (exclusivo), note }
  let i = 0;
  while (i < n) {
    if (filtered[i] < 0) { i++; continue; }
    let j = i;
    const seen = [filtered[i]];
    while (j + 1 < n && filtered[j + 1] >= 0 && Math.abs(filtered[j + 1] - median(seen)) <= 1) seen.push(filtered[++j]);
    segments.push({ from: i, to: j + 1, note: median(seen) });
    i = j + 1;
  }
  // trechos curtos demais viram parte do vizinho colado de nota mais próxima (ou somem se estão isolados)
  const result = Array(n).fill(-1);
  segments.forEach((seg, k) => {
    let note = seg.note;
    if (seg.to - seg.from < minFrames) {
      const near = [segments[k - 1], segments[k + 1]].filter((o) => o && (o.to === seg.from || o.from === seg.to) && o.to - o.from >= minFrames);
      if (!near.length) return;
      note = near.reduce((a, b) => (Math.abs(a.note - seg.note) <= Math.abs(b.note - seg.note) ? a : b)).note;
    }
    result.fill(note, seg.from, seg.to);
  });
  return result;
}

const pitchClass = (midiNote) => ((Math.round(midiNote) % 12) + 12) % 12;
const mostFrequent = (counts) => [...counts].reduce((best, entry) => (!best || entry[1] > best[1] ? entry : best), null)?.[0] ?? null;

/** Nome da nota sem a oitava ("A" para 69, 57, 81...). */
export const classNameOf = (pc) => (pc == null ? '—' : NAMES[pc]);

/**
 * Pontua a música em blocos de 2 s. `melody` = { hop, midi: [nota | -1] }; `transpose` = tom escolhido (semitones).
 * Em cada bloco confere UMA nota: a que o cantor mais cantou contra as notas principais que a original sustenta nele,
 * ignorando a oitava. `onBlock(linha)` é chamada quando um bloco termina (depuração). Só contam os quadros em que a voz original canta; quadros já avaliados (seek) não contam duas vezes.
 */
export function createScorer(melody, { transpose = 0, onBlock = null } = {}) {
  const { hop } = melody;
  const midi = smoothMelody(melody.midi); // a referência é a melodia estável, não a crua
  const blockFrames = Math.round(BLOCK_SECONDS / hop);
  let shift = transpose;
  const seen = new Uint8Array(midi.length);
  const blocks = new Map(); // bloco -> { n: leituras com voz na original, heard: leituras com tom detectado, hist: nota (0..11) -> leituras }
  const refCache = new Map(); // bloco -> { display: nota mais frequente, classes: [notas principais] } | null
  let counted = 0;
  let heldNote = null;
  let heldAt = -Infinity;
  let reference = null; // nota de referência do bloco atual, já no tom escolhido
  let sungNow = null; // nota que o cantor mais cantou no bloco atual
  let lastBlock = null;

  function refOf(block) {
    if (refCache.has(block)) return refCache.get(block);
    const notes = new Map();
    const classes = new Map();
    let voiced = 0;
    for (let i = block * blockFrames; i < Math.min(midi.length, (block + 1) * blockFrames); i++) {
      if (midi[i] < 0) continue;
      voiced++;
      notes.set(midi[i], (notes.get(midi[i]) ?? 0) + 1);
      classes.set(pitchClass(midi[i]), (classes.get(pitchClass(midi[i])) ?? 0) + 1);
    }
    const info = voiced < MIN_REF_FRAMES ? null : {
      display: mostFrequent(notes),
      // nenhuma nota chega ao limite (a original passa por várias): vale a mais frequente
      classes: [...classes].filter(([, count]) => count >= voiced * MAIN_SHARE || count === Math.max(...classes.values())).map(([pc]) => pc),
    };
    refCache.set(block, info);
    return info;
  }

  const clock = (seconds) => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

  /** A comparação de um bloco: o que a original sustenta, o que foi cantado e quantos pontos deu. */
  function evaluate(block) {
    const { n, heard, hist } = blocks.get(block);
    const ref = refOf(block);
    const sungClass = mostFrequent(hist);
    let dist = null;
    let accuracy = 0;
    let participation = 0;
    if (heard && ref) {
      dist = Math.min(...ref.classes.map((pc) => pitchClassDistance(sungClass, pc + shift)));
      accuracy = creditFor(dist);
      participation = Math.min(1, heard / n / PARTICIPATION_FULL);
    }
    return { n, heard, ref, sungClass, dist, accuracy, participation, points: n * participation * accuracy };
  }

  /** Uma linha legível por bloco (trecho, nota original, nota cantada, resultado). */
  function explain(block) {
    const { n, heard, ref, sungClass, dist, accuracy, participation } = evaluate(block);
    return {
      trecho: `${clock(block * BLOCK_SECONDS)}–${clock((block + 1) * BLOCK_SECONDS)}`,
      original: ref ? noteName(ref.display + shift) : '—',
      principais: ref ? ref.classes.map((pc) => classNameOf((pc + shift + 120) % 12)).join('/') : '',
      cantada: heard ? classNameOf(sungClass) : '—',
      distancia: dist,
      acerto: accuracy,
      leituras: `${heard}/${n}`,
      participacao: Math.round(participation * 100) / 100,
    };
  }

  return {
    /** t = posição da música (s); captured = nota MIDI captada no microfone (ou null: silêncio). Devolve a nota ao vivo (0..100) ou null. */
    tick(t, captured) {
      if (captured != null) {
        heldNote = captured;
        heldAt = t;
      }
      const sung = captured ?? (t - heldAt <= HOLD_SECONDS && t >= heldAt ? heldNote : null);
      const idx = Math.floor(t / hop);
      const block = Math.floor(idx / blockFrames);
      if (onBlock && lastBlock !== null && block !== lastBlock && blocks.has(lastBlock)) onBlock(explain(lastBlock));
      lastBlock = block;
      const ref = idx >= 0 && idx < midi.length ? refOf(block) : null;
      reference = ref ? ref.display + shift : null;
      sungNow = mostFrequent(blocks.get(block)?.hist ?? new Map());
      if (!ref || midi[idx] < 0 || seen[idx]) return this.score();
      seen[idx] = 1;
      counted++;
      const blk = blocks.get(block) ?? { n: 0, heard: 0, hist: new Map() };
      blocks.set(block, blk);
      blk.n++;
      if (sung != null) {
        blk.heard++;
        blk.hist.set(pitchClass(sung), (blk.hist.get(pitchClass(sung)) ?? 0) + 1);
        sungNow = mostFrequent(blk.hist);
      }
      return this.score();
    },
    /** O tom pode mudar no meio da música: a melodia de referência acompanha. */
    setTranspose(semitones) { shift = semitones; },
    /** Nota 0..100 (null enquanto não houve nenhum quadro avaliado). */
    score() {
      let total = 0;
      let points = 0;
      for (const block of blocks.keys()) {
        total += blocks.get(block).n;
        points += evaluate(block).points;
      }
      return total ? Math.round((100 * points) / total) : null;
    },
    /** Todos os blocos já avaliados, em ordem, para `console.table` no fim da música. */
    report: () => [...blocks.keys()].sort((a, b) => a - b).map(explain),
    get reference() { return reference; },
    get sung() { return sungNow; },
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
