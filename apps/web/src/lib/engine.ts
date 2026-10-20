// The TV's engine: plays the instrumental (and, when there are any, the backing vocals) with real-time pitch shifting and draws
// the synced lyrics.
import { t } from '../i18n/index.ts';
import { SoundTouchNode } from '../vendor/soundtouch/SoundTouchNode.js';
import { createFeedbackGuard, type FeedbackGuard } from './feedback.ts';
import { blockRms, createGate, GATE, type Gate } from './voice-gate.ts';
import { heardPosition } from './latency.ts';
import { clampBacking, clampPitch } from './lyrics-sync.ts';
import { createLyricsView, type LyricsElements } from './lyrics-view.ts';
import type { LyricCue, QueueItem } from './types.ts';

export interface EngineOptions {
  /** The elements where the lyrics are drawn. */
  lyricsEls: LyricsElements;
  /** Called when the song ends. */
  onEnded?(itemId: number | null): void;
  onError?(itemId: number | null, message: string): void;
  /** The song's lyrics loaded (the TV passes them on to the singers' Stage). */
  onLyrics?(itemId: number, cues: LyricCue[]): void;
  /** The howl (feedback) was detected and the voice's volume was cut. */
  onFeedback?(info: { hz: number | null; factor: number; mic: number; mics: number }): void;
}

/** An extra track at the instrumental's position, with the volume chosen by whoever picked the song. */
interface Stem {
  element: HTMLAudioElement;
  /** The current song's file (null = the song has none). */
  url: string | null;
  /** 0..100 (%). */
  level: number;
  /** What the audio element already loaded (it only downloads once the level goes above 0). */
  loadedUrl: string | null;
  gain: GainNode | null;
}

/** One microphone's chain on the output. */
interface MicChain {
  stream: MediaStream;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  highpass: BiquadFilterNode;
  gate: GainNode;
  gain: GainNode;
  noiseGate: Gate;
  guard: FeedbackGuard;
  spectrum: Float32Array<ArrayBuffer>;
  samples: Float32Array<ArrayBuffer>;
}

export function createEngine({ lyricsEls, onEnded, onError, onLyrics, onFeedback }: EngineOptions) {
  const audio = new Audio();
  audio.crossOrigin = 'anonymous';
  audio.preload = 'auto';
  // extra tracks, at the instrumental's position and with the volume chosen by whoever picked the song:
  // the backing vocals (backing) and the isolated original voice, as a guide for singing (guide)
  function createStem(): Stem {
    const element = new Audio();
    element.crossOrigin = 'anonymous';
    element.preload = 'auto';
    return { element, url: null, level: 0, loadedUrl: null, gain: null };
  }
  const backing = createStem();
  const guide = createStem();
  const stems = [backing, guide];

  let itemId: number | null = null;
  const view = createLyricsView(lyricsEls);
  let pitch = 0;
  let ctx: AudioContext | null = null;
  let stNode: SoundTouchNode | null = null;
  let graphReady: Promise<AudioContext> | null = null;
  let pitchAvailable = true;
  let loadToken = 0;
  let outputMs = 0; // the sound's delay to the ears (speaker, Bluetooth): the lyrics show what is heard now
  // the voice of the TV's microphones on the output (it skips SoundTouch: the pitch change is the song's, not the voice's):
  //   each microphone -> analyser (feedback detector) + its own gain (the guard cuts only the howling microphone)
  //   -> sum (the voice's volume, the same for all) -> limiter (several microphones added up do not clip) -> output
  let mics: MicChain[] = [];
  let voiceNode: GainNode | null = null; // the sum, with the voice's volume
  let limiter: DynamicsCompressorNode | null = null;
  let voiceGainValue = 0;
  let voiceFilterOn = true; // high-pass filter and noise gate on the voice
  let feedbackTimer: ReturnType<typeof setInterval> | undefined;

  // --- audio: <audio> -> SoundTouch (pitch) -> output; without an AudioWorklet (an http page outside localhost) it plays without pitch ---
  function ensureGraph(): Promise<AudioContext> {
    graphReady ??= (async () => {
      const context = new AudioContext();
      ctx = context;
      if (!window.isSecureContext || !context.audioWorklet) {
        pitchAvailable = false; // AudioWorklet only exists on https or localhost
        return context;
      }
      try {
        await SoundTouchNode.register(context, '/vendor/soundtouch/soundtouch-processor.js');
        const node = new SoundTouchNode({ context });
        stNode = node;
        context.createMediaElementSource(audio).connect(node);
        // the extra tracks go into SoundTouch's same input: they all change pitch together
        for (const stem of stems) {
          stem.gain = context.createGain();
          context.createMediaElementSource(stem.element).connect(stem.gain);
          stem.gain.connect(node);
        }
        node.connect(context.destination);
        applyPitch();
        stems.forEach(applyStem);
      } catch (err) {
        console.warn('pitch shifting unavailable:', err);
        pitchAvailable = false;
        stNode = null;
      }
      return context;
    })();
    return graphReady;
  }

  function applyVoice() {
    if (!ctx) return; // no graph yet: there is no voice to adjust
    // the requested volume on the sum and, on each microphone, the guard's factor; a short ramp avoids a click when cutting
    if (voiceNode) voiceNode.gain.setTargetAtTime(voiceGainValue, ctx.currentTime, 0.02);
    for (const mic of mics) mic.gain.gain.setTargetAtTime(mic.guard.factor, ctx.currentTime, 0.02);
  }

  /** Checks a microphone's spectrum (dB): if it is a howl, cuts only that voice and reports it. The timer calls this; so do the tests. */
  function checkFeedback(spectrumDb: Float32Array | number[], nowMs: number, index = 0) {
    const mic = mics[index];
    if (!mic) return { factor: 1, triggered: false, hz: null };
    const result = mic.guard.update(spectrumDb, nowMs, ctx?.sampleRate ?? 48000);
    if (result.triggered) {
      applyVoice();
      onFeedback?.({ hz: result.hz, factor: result.factor, mic: index, mics: mics.length });
    } else if (Math.abs(mic.gain.gain.value - result.factor) > 0.01) {
      applyVoice(); // the volume is coming back slowly
    }
    return result;
  }

  /** A microphone's noise gate: given the volume (RMS) and the instant, it opens or closes. The timer calls this; so do the tests. */
  function stepGate(rms: number, nowMs: number, index = 0) {
    const mic = mics[index];
    if (!mic || !ctx) return 1;
    const target = voiceFilterOn ? mic.noiseGate.target(rms, nowMs) : 1;
    // opens fast (the first syllable must not be cut) and closes slowly (no "pumping" on every breath)
    mic.gate.gain.setTargetAtTime(target, ctx.currentTime, target === 1 ? 0.01 : 0.12);
    return target;
  }

  function applyPitch() {
    if (stNode) stNode.pitchSemitones.value = pitch;
  }

  // --- extra tracks (backing vocals and the original voice) ---
  const stemWanted = (stem: Stem) => Boolean(stem.url) && stem.level > 0;

  function applyStem(stem: Stem) {
    const level = stem.level / 100;
    if (stem.gain) {
      stem.gain.gain.value = level;
      // the ELEMENT's volume applies before the audio graph: stuck at 0 (as it was while the graph did not exist) it silences the track
      stem.element.volume = 1;
    } else {
      stem.element.volume = level; // without the audio graph (http outside localhost) the element's own volume does the job
    }
    if (!stemWanted(stem) || !stem.url) {
      stem.element.pause();
      return;
    }
    if (stem.loadedUrl !== stem.url) {
      stem.element.src = stem.url;
      stem.element.load();
      stem.loadedUrl = stem.url;
    }
    if (!audio.paused) syncStem(stem);
  }

  /** Puts the track at the instrumental's position and makes it play along. */
  function syncStem(stem: Stem) {
    if (!stemWanted(stem)) return;
    stem.element.currentTime = audio.currentTime;
    if (stem.element.paused) stem.element.play().catch(() => {}); // without the gesture that unlocks sound, the instrumental does not play either
  }

  function dropStem(stem: Stem) {
    stem.element.pause();
    if (stem.loadedUrl) {
      stem.element.removeAttribute('src');
      stem.element.load();
      stem.loadedUrl = null;
    }
    stem.url = null;
  }

  // two audio elements never move exactly together: every half second each track is realigned if it slipped
  setInterval(() => {
    for (const stem of stems) {
      if (stemWanted(stem) && !audio.paused && !stem.element.paused && Math.abs(stem.element.currentTime - audio.currentTime) > 0.08) {
        stem.element.currentTime = audio.currentTime;
      }
    }
  }, 500);

  // --- lyrics: the drawing lives in lyrics-view.ts; here it only passes the audio's clock ---
  function render() {
    if (itemId !== null) view.render(heardPosition(audio.currentTime, outputMs));
  }

  function loop() {
    render();
    if (!audio.paused) requestAnimationFrame(loop);
  }

  audio.addEventListener('play', () => {
    requestAnimationFrame(loop);
    stems.forEach(syncStem);
  });
  audio.addEventListener('pause', () => {
    for (const stem of stems) stem.element.pause();
    render();
  });
  audio.addEventListener('seeked', () => {
    for (const stem of stems) if (stemWanted(stem)) stem.element.currentTime = audio.currentTime;
    render();
  });
  audio.addEventListener('ended', () => onEnded?.(itemId));
  audio.addEventListener('error', () => onError?.(itemId, t('engine.audioFail')));

  return {
    /** Unlocks the sound: it must be called inside a click (the browsers' autoplay policy). */
    async unlock() {
      const context = await ensureGraph();
      await context.resume();
    },

    /** Loads a queue item (lyrics.json + instrumental) without playing it. */
    async load(item: QueueItem) {
      const media = item.song.media!; // only ready songs are loaded, and a ready song has its files
      const token = ++loadToken;
      audio.pause();
      stems.forEach(dropStem);
      backing.url = media.backing ?? null;
      backing.level = clampBacking(item.backing);
      guide.url = media.vocals ?? null;
      guide.level = clampBacking(item.guide);
      itemId = item.id;
      view.setCues([]);
      view.setOffset(item.lyric_offset ?? 0);
      pitch = clampPitch(item.pitch);
      applyPitch();
      try {
        const res = await fetch(media.lyrics);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const loaded = await res.json();
        if (token !== loadToken) return; // another song was asked for halfway through
        view.setDuet(item.guest?.status === 'accepted', item.parts); // Duet: the lyrics take both colors (the singers' split, if any)
        view.setCues(loaded);
        onLyrics?.(item.id, loaded);
      } catch (err) {
        onError?.(item.id, t('engine.lyricsFail', { error: (err as Error).message }));
        return;
      }
      audio.src = media.instrumental;
      audio.load();
      stems.forEach(applyStem);
      render();
    },

    /** Plugs one or more microphones (`streams`) into the audio output, together with the music. The volume comes from `setVoiceGain`. */
    async attachVoice(streams: MediaStream | MediaStream[]) {
      const context = await ensureGraph();
      this.detachVoice();
      if (!voiceNode) {
        voiceNode = context.createGain();
        // limiter: two or more singers added up must not clip the output
        limiter = context.createDynamicsCompressor();
        limiter.threshold.value = -6;
        limiter.knee.value = 0;
        limiter.ratio.value = 20;
        limiter.attack.value = 0.003;
        limiter.release.value = 0.1;
        voiceNode.connect(limiter);
        limiter.connect(context.destination);
      }
      for (const stream of Array.isArray(streams) ? streams : [streams]) {
        const source = context.createMediaStreamSource(stream);
        const highpass = context.createBiquadFilter(); // removes the rumble and the handling noise
        highpass.type = 'highpass';
        highpass.Q.value = 0.7;
        highpass.frequency.value = voiceFilterOn ? GATE.filterHz : 10;
        const gate = context.createGain(); // the noise gate: closes when nobody sings
        const gain = context.createGain(); // the feedback guard's gain
        const analyser = context.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0;
        source.connect(analyser); // the feedback detector and the gate listen to the microphone BEFORE everything else
        source.connect(highpass);
        highpass.connect(gate);
        gate.connect(gain);
        gain.connect(voiceNode);
        mics.push({
          stream, source, analyser, highpass, gate, gain,
          noiseGate: createGate(),
          guard: createFeedbackGuard(),
          spectrum: new Float32Array(analyser.frequencyBinCount),
          samples: new Float32Array(analyser.fftSize),
        });
      }
      feedbackTimer = setInterval(() => {
        if (voiceGainValue <= 0) return; // the voice is off or muted: no howl is possible
        mics.forEach((mic, index) => {
          mic.analyser.getFloatFrequencyData(mic.spectrum);
          checkFeedback(mic.spectrum, performance.now(), index);
          if (voiceFilterOn) {
            mic.analyser.getFloatTimeDomainData(mic.samples);
            stepGate(blockRms(mic.samples), performance.now(), index);
          }
        });
      }, 50);
      applyVoice();
    },

    /** Turns the voice's high-pass filter and noise gate on or off (it applies at once, also with the voice already on). */
    setVoiceFilter(on: boolean) {
      voiceFilterOn = Boolean(on);
      for (const mic of mics) {
        mic.highpass.frequency.value = voiceFilterOn ? GATE.filterHz : 10;
        if (!voiceFilterOn && ctx) mic.gate.gain.setTargetAtTime(1, ctx.currentTime, 0.01);
      }
    },
    stepGate,

    /** Turns the voice off and releases the microphones. */
    detachVoice() {
      clearInterval(feedbackTimer);
      feedbackTimer = undefined;
      for (const mic of mics) {
        mic.analyser.disconnect();
        mic.source.disconnect();
        mic.highpass.disconnect();
        mic.gate.disconnect();
        mic.gain.disconnect();
        for (const track of mic.stream.getTracks()) track.stop();
      }
      mics = [];
    },

    /** The voice's gain on the output (0 = muted). */
    setVoiceGain(gain: number) {
      voiceGainValue = Math.max(0, Number(gain) || 0);
      applyVoice();
    },

    async play() {
      const context = await ensureGraph();
      await context.resume();
      await audio.play();
    },

    pause() {
      audio.pause();
    },

    /** Goes to a point in the song (e.g. the TV was reloaded and resumes where it was). */
    seek(seconds: number) {
      audio.currentTime = Math.max(0, Number(seconds) || 0);
    },

    setPitch(value: number) {
      pitch = clampPitch(value);
      applyPitch();
    },

    /** The backing vocals' level (0..100 %); it only downloads the file once it goes above 0. */
    setBacking(level: number) {
      const next = clampBacking(level);
      if (next === backing.level) return;
      backing.level = next;
      applyStem(backing);
    },

    /** The original voice's level, as a guide (0..100 %); it only downloads the file once it goes above 0. */
    setGuide(level: number) {
      const next = clampBacking(level);
      if (next === guide.level) return;
      guide.level = next;
      applyStem(guide);
    },

    setOffset(seconds: number) {
      view.setOffset(seconds);
      render();
    },

    /**
     * Duet on or off for the current song (it also applies in the middle of it).
     * @param chosen the split chosen by the singers (text of a b * -)
     */
    setDuet(on: boolean, chosen: string | null = null) {
      view.setDuet(on, chosen);
      render();
    },

    clear() {
      audio.pause();
      stems.forEach(dropStem);
      itemId = null;
      view.clear();
    },

    get loadedId() { return itemId; },
    get playing() { return !audio.paused; },
    get currentTime() { return audio.currentTime; },
    /** The song's position heard now (the one the engine plays, minus the output's delay). */
    get heardTime() { return heardPosition(audio.currentTime, outputMs); },
    /** The sound's delay to the ears, in ms: the lyrics (and the position sent to the phones) follow what is heard. */
    setOutputLatency(ms: number) {
      outputMs = Math.max(0, Number(ms) || 0);
      render();
    },
    get duration() { return audio.duration || 0; },
    get pitchAvailable() { return pitchAvailable; },
    get unlocked() { return ctx?.state === 'running'; },
    get pitch() { return pitch; },
    get backingLevel() { return backing.level; },
    get hasBacking() { return Boolean(backing.url); },
    get backingPlaying() { return !backing.element.paused; },
    get backingTime() { return backing.element.currentTime; },
    get guideLevel() { return guide.level; },
    get hasGuide() { return Boolean(guide.url); },
    get guidePlaying() { return !guide.element.paused; },
    get guideTime() { return guide.element.currentTime; },
    /** Diagnostics for the backing track (audio element and graph): to understand why it does not sound. */
    get backingDebug() {
      return {
        readyState: backing.element.readyState, networkState: backing.element.networkState, error: backing.element.error?.code ?? null, paused: backing.element.paused,
        muted: backing.element.muted, volume: backing.element.volume, src: backing.element.currentSrc, duration: backing.element.duration,
        gain: backing.gain?.gain.value ?? null, ctx: ctx?.state ?? null, graph: Boolean(stNode),
      };
    },
    get voiceAttached() { return mics.length > 0; },
    /** How many microphones are on the output. */
    get voiceMics() { return mics.length; },
    get voiceFilter() { return voiceFilterOn; },
    /** The first microphone's noise gate gain (1 = open). */
    get voiceGateGain() { return mics[0] ? mics[0].gate.gain.value : 1; },
    get voiceGain() { return voiceGainValue; },
    /** How much of the requested volume the feedback guard lets through (1 = all; less = cut because of the howl). */
    get voiceFactor() { return mics.length ? Math.min(...mics.map((mic) => mic.guard.factor)) : 1; },
    /** The gain actually on the output (the requested one times the guard's factor). */
    get voiceOutputGain() { return voiceNode && mics.length ? voiceNode.gain.value * Math.max(...mics.map((mic) => mic.gain.gain.value)) : 0; },
    checkFeedback,
    /** The audio context's sample rate (the tests build spectra at the right size). */
    get sampleRateForTests() { return ctx?.sampleRate ?? 48000; },
    get offset() { return view.offset; },
    get cues() { return view.cues; },
  };
}
