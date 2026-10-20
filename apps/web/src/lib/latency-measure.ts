// Measuring the TV's delay: plays clicks through the speakers and listens on the microphone for how long they take to come back.
// It only works with the sound loud enough for the microphone to hear and a quiet room; the result is the round trip (output +
// input + the air between them).
import { detectOnsets, estimateDelay } from './latency.ts';

const CLICKS = 6;
const SPACING = 0.8; // s between one click and the next
const LEAD = 0.6; // s of silence before the first one (the microphone is already listening)

export interface RoundTrip {
  /** null = the clicks were not heard (low volume, wrong microphone, noise). */
  roundTripMs: number | null;
  outputLatencyMs: number;
  heard: number;
}

export async function measureRoundTrip({
  getUserMedia = (c) => navigator.mediaDevices.getUserMedia(c),
  AudioContextClass = AudioContext,
}: { getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>; AudioContextClass?: typeof AudioContext } = {}): Promise<RoundTrip> {
  // no echo cancellation or noise suppression: they would "clean" the click as if it were the TV's own echo
  const stream = await getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  const ctx = new AudioContextClass();
  try {
    await ctx.resume();
    const chunks: Float32Array[] = [];
    const source = ctx.createMediaStreamSource(stream);
    const recorder = ctx.createScriptProcessor(512, 1, 1);
    const mute = ctx.createGain();
    mute.gain.value = 0; // the processor only runs connected to the output, but we do not want to hear the microphone
    let startedAt: number | null = null; // the context's instant when the first recorded sample was delivered
    recorder.onaudioprocess = (event) => {
      if (startedAt === null) startedAt = event.playbackTime - event.inputBuffer.length / ctx.sampleRate;
      chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
    };
    source.connect(recorder);
    recorder.connect(mute);
    mute.connect(ctx.destination);

    await new Promise((resolve) => setTimeout(resolve, 200)); // let the recording start
    const clickTimes: number[] = []; // the context's instants when each click was sent to the output
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
