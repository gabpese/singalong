// The sound of the applause on the TV, generated on the spot (no audio file): hundreds of short claps, each one a burst of noise with a
// slightly different timbre, spread over time, on top of a low murmur from the audience. It starts strong and dies away.

const CLAPS_PER_SECOND = 26;

/** Plays the applause for `seconds` seconds; returns the function that cuts the sound before the end (the phase ended or was skipped). */
export function playApplause(seconds: number, volume = 0.5): () => void {
  const Context = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Context || seconds <= 0.3) return () => {};
  let context: AudioContext;
  try {
    context = new Context();
  } catch {
    return () => {};
  }
  void context.resume().catch(() => {});

  const noise = context.createBuffer(1, context.sampleRate, context.sampleRate);
  const samples = noise.getChannelData(0);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.random() * 2 - 1;

  const start = context.currentTime + 0.05;
  const end = start + seconds;
  const master = context.createGain();
  master.gain.setValueAtTime(0, start);
  master.gain.linearRampToValueAtTime(volume, start + 0.6); // the audience bursts out
  master.gain.setValueAtTime(volume, start + seconds * 0.45);
  master.gain.linearRampToValueAtTime(0, end); // and calms down
  master.connect(context.destination);

  for (let i = 0; i < Math.round(seconds * CLAPS_PER_SECOND); i++) {
    const at = start + Math.random() * seconds;
    const source = context.createBufferSource();
    source.buffer = noise;
    const tone = context.createBiquadFilter();
    tone.type = 'bandpass';
    tone.frequency.value = 900 + Math.random() * 1700; // different hands, different claps
    tone.Q.value = 1.1;
    const gain = context.createGain();
    gain.gain.setValueAtTime(0, at);
    gain.gain.linearRampToValueAtTime(0.25 + Math.random() * 0.5, at + 0.004);
    gain.gain.exponentialRampToValueAtTime(0.001, at + 0.05 + Math.random() * 0.06);
    source.connect(tone).connect(gain).connect(master);
    source.start(at, Math.random() * 0.8, 0.12);
  }

  const crowd = context.createBufferSource(); // the murmur under the claps
  crowd.buffer = noise;
  crowd.loop = true;
  const low = context.createBiquadFilter();
  low.type = 'lowpass';
  low.frequency.value = 650;
  const crowdGain = context.createGain();
  crowdGain.gain.value = 0.2;
  crowd.connect(low).connect(crowdGain).connect(master);
  crowd.start(start);
  crowd.stop(end);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    void context.close().catch(() => {});
  };
  const timer = setTimeout(close, (seconds + 0.5) * 1000);
  return () => {
    clearTimeout(timer);
    close();
  };
}
