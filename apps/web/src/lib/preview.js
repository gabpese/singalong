// Prévia do instrumental no celular, com troca de tom. Usa a versão do SoundTouch baseada em ScriptProcessor porque,
// ao contrário do AudioWorklet, ela funciona em páginas http por IP (o celular entra na sala por http://192.168...).
// Custo: decodifica a música inteira na memória (alguns MB) e processa na thread principal. Serve bem para ouvir uma prévia.
import { PitchShifter } from '../vendor/soundtouch-legacy/soundtouch.js';
import { clampPitch } from './lyrics-sync.js';

export function createPreviewPlayer({ onEnded } = {}) {
  let ctx = null;
  let analyser = null;
  let shifter = null;
  let playing = false;
  let pitch = 0;
  let token = 0; // invalida carregamentos antigos quando a pessoa troca de música no meio do download

  function context() {
    if (!ctx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
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
        // já desconectado
      }
    }
    shifter = null;
    playing = false;
  }

  return {
    /** Baixa e decodifica a música; chame dentro de um clique (o navegador só libera o áudio após um gesto). */
    async load(url) {
      const mine = ++token;
      stopCurrent();
      const audioCtx = context();
      await audioCtx.resume();
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Não consegui baixar a música (${response.status}).`);
      const buffer = await audioCtx.decodeAudioData(await response.arrayBuffer());
      if (mine !== token) return false; // outra prévia foi pedida enquanto esta baixava
      shifter = new PitchShifter(audioCtx, buffer, 4096, () => {
        playing = false;
        onEnded?.();
      });
      shifter.pitchSemitones = pitch;
      return true;
    },

    async play() {
      if (!shifter) return;
      await ctx.resume();
      shifter.connect(analyser);
      playing = true;
    },

    pause() {
      if (shifter) shifter.disconnect();
      playing = false;
    },

    /** `fraction` de 0 a 1. */
    seek(fraction) {
      if (shifter) shifter.percentagePlayed = Math.min(Math.max(fraction, 0), 1); // o setter recebe fração (o getter, percentual)
    },

    setPitch(semitones) {
      pitch = clampPitch(semitones);
      if (shifter) shifter.pitchSemitones = pitch;
    },

    /** Para e libera a música carregada. */
    unload() {
      token++;
      stopCurrent();
    },

    /** Volume instantâneo (RMS, 0..1): útil para saber se há som saindo. */
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
