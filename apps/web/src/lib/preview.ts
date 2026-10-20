// The instrumental's preview on the phone, with pitch shifting. It uses the ScriptProcessor-based version of SoundTouch because,
// unlike the AudioWorklet, it works on http pages reached by IP (the phone joins the Room through http://192.168...).
// Cost: it decodes the whole song into memory (a few MB) and processes on the main thread. Good enough to hear a preview.
import { t } from '../i18n/index.ts';
import { PitchShifter } from '../vendor/soundtouch-legacy/soundtouch.js';
import { clampPitch } from './lyrics-sync.ts';

export interface PreviewPlayer {
  /** Downloads and decodes the song; call it inside a click (the browser only allows audio after a gesture). */
  load(url: string): Promise<boolean>;
  play(): Promise<void>;
  pause(): void;
  /** `fraction` from 0 to 1. */
  seek(fraction: number): void;
  setPitch(semitones: number): void;
  /** Stops and releases the loaded song. */
  unload(): void;
  /** Instant volume (RMS, 0..1): useful to know whether sound is coming out. */
  level(): number;
  readonly loaded: boolean;
  readonly playing: boolean;
  readonly duration: number;
  readonly position: number;
  readonly pitch: number;
}

export function createPreviewPlayer({ onEnded }: { onEnded?: () => void } = {}): PreviewPlayer {
  let ctx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let shifter: PitchShifter | null = null;
  let playing = false;
  let pitch = 0;
  let token = 0; // invalidates older loads when the person switches songs in the middle of a download

  function context(): AudioContext {
    if (!ctx) {
      const AudioContextClass = window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      ctx = new AudioContextClass();
      analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.connect(ctx.destination);
    }
    return ctx;
  }

  function stopCurrent() {
    if (shifter) {
      try {
        shifter.disconnect();
      } catch {
        // already disconnected
      }
    }
    shifter = null;
    playing = false;
  }

  return {
    async load(url) {
      const mine = ++token;
      stopCurrent();
      const audioCtx = context();
      await audioCtx.resume();
      const response = await fetch(url);
      if (!response.ok) throw new Error(t('preview.downloadFail', { status: response.status }));
      const buffer = await audioCtx.decodeAudioData(await response.arrayBuffer());
      if (mine !== token) return false; // another preview was asked for while this one downloaded
      shifter = new PitchShifter(audioCtx, buffer, 4096, () => {
        playing = false;
        onEnded?.();
      });
      shifter.pitchSemitones = pitch;
      return true;
    },

    async play() {
      if (!shifter || !ctx) return;
      await ctx.resume();
      shifter.connect(analyser);
      playing = true;
    },

    pause() {
      if (shifter) shifter.disconnect();
      playing = false;
    },

    seek(fraction) {
      if (shifter) shifter.percentagePlayed = Math.min(Math.max(fraction, 0), 1); // the setter takes a fraction (the getter, a percentage)
    },

    setPitch(semitones) {
      pitch = clampPitch(semitones);
      if (shifter) shifter.pitchSemitones = pitch;
    },

    unload() {
      token++;
      stopCurrent();
    },

    level() {
      if (!analyser) return 0;
      const data = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(data);
      return Math.sqrt(data.reduce((sum, v) => sum + v * v, 0) / data.length);
    },

    get loaded() { return shifter !== null; },
    get playing() { return playing; },
    get duration() { return shifter?.duration ?? 0; },
    get position() { return shifter ? (shifter.percentagePlayed / 100) * shifter.duration : 0; },
    get pitch() { return pitch; },
  };
}
