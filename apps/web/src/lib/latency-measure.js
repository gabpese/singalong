// Medição do atraso na TV: toca estalos pelas caixas e escuta no microfone quanto demoram a voltar. Só funciona com som alto o
// bastante para o microfone ouvir e uma sala sem barulho; o resultado é a ida e volta (saída + entrada + o ar entre os dois).
import { detectOnsets, estimateDelay } from './latency.js';

const CLICKS = 6;
const SPACING = 0.8; // s entre um estalo e o seguinte
const LEAD = 0.6; // s de silêncio antes do primeiro (o microfone já está ouvindo)

/**
 * @param {{ getUserMedia?: Function, AudioContextClass?: typeof AudioContext }} [deps]
 * @returns {Promise<{ roundTripMs: number | null, outputLatencyMs: number, heard: number }>}
 *   `roundTripMs` null = os estalos não foram ouvidos (volume baixo, microfone errado, barulho).
 */
export async function measureRoundTrip({ getUserMedia = (c) => navigator.mediaDevices.getUserMedia(c), AudioContextClass = AudioContext } = {}) {
  // sem cancelamento de eco nem supressão de ruído: eles "limpariam" o estalo como se fosse eco da própria TV
  const stream = await getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  const ctx = new AudioContextClass();
  try {
    await ctx.resume();
    const chunks = [];
    const source = ctx.createMediaStreamSource(stream);
    const recorder = ctx.createScriptProcessor(512, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0; // o processador só funciona ligado à saída, mas não queremos ouvir o microfone
    let startedAt = null; // instante do contexto em que a primeira amostra gravada foi entregue
    recorder.onaudioprocess = (event) => {
      if (startedAt === null) startedAt = event.playbackTime - event.inputBuffer.length / ctx.sampleRate;
      chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    };
    source.connect(recorder);
    recorder.connect(mute);
    mute.connect(ctx.destination);

    await new Promise((resolve) => setTimeout(resolve, 200)); // deixa a gravação começar
    const clickTimes = []; // instantes do contexto em que cada estalo foi mandado para a saída
    const first = ctx.currentTime + LEAD;
    for (let i = 0; i < CLICKS; i++) {
      const at = first + i * SPACING;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 1800;
      gain.gain.setValueAtTime(0, at);
      gain.gain.linearRampToValueAtTime(0.9, at + 0.002);
      gain.gain.exponentialRampToValueAtTime(0.001, at + 0.04);
      osc.connect(gain).connect(ctx.destination);
      osc.start(at);
      osc.stop(at + 0.06);
      clickTimes.push(at);
    }
    await new Promise((resolve) => setTimeout(resolve, (LEAD + CLICKS * SPACING + 1) * 1000));

    recorder.disconnect();
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const samples = new Float32Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      samples.set(chunk, offset);
      offset += chunk.length;
    }
    const onsets = detectOnsets(samples, ctx.sampleRate).map((time) => time + (startedAt ?? 0));
    return {
      roundTripMs: estimateDelay(clickTimes, onsets),
      outputLatencyMs: Math.round((ctx.outputLatency || ctx.baseLatency || 0) * 1000),
      heard: onsets.length,
    };
  } finally {
    for (const track of stream.getTracks()) track.stop();
    await ctx.close();
  }
}
