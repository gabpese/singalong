// Motor da TV: toca o instrumental (e, se houver, as vozes de apoio) com troca de tom em tempo real e desenha a letra sincronizada.
import { t } from '../i18n/index.js';
import { SoundTouchNode } from '../vendor/soundtouch/SoundTouchNode.js';
import { createFeedbackGuard } from './feedback.js';
import { heardPosition } from './latency.js';
import { clampBacking, clampPitch } from './lyrics-sync.js';
import { createLyricsView } from './lyrics-view.js';

/**
 * @param lyricsEls elementos { prev, current, next, next2 } onde a letra é desenhada
 * @param onEnded   (itemId) => void   chamada quando a música termina
 * @param onError   (itemId, mensagem) => void
 * @param onLyrics  (itemId, linhas) => void   a letra da música carregou (a TV a repassa ao palco dos cantores)
 * @param onFeedback ({ hz, factor }) => void   o apito (microfonia) foi detectado e o volume da voz foi cortado
 */
export function createEngine({ lyricsEls, onEnded, onError, onLyrics, onFeedback }) {
  const audio = new Audio();
  audio.crossOrigin = 'anonymous';
  audio.preload = 'auto';
  // vozes de apoio: um segundo áudio, no mesmo ponto do instrumental, com o volume que quem escolheu a música definiu
  const backing = new Audio();
  backing.crossOrigin = 'anonymous';
  backing.preload = 'auto';

  let itemId = null;
  const view = createLyricsView(lyricsEls);
  let pitch = 0;
  let backingUrl = null; // as vozes de apoio da música atual (null = a música não tem)
  let backingLevel = 0; // 0..100 (%)
  let backingLoadedUrl = null; // o que o elemento de áudio já carregou (só baixa quando o nível passa de 0)
  let backingGain = null;
  let ctx = null;
  let stNode = null;
  let graphReady = null;
  let pitchAvailable = true;
  let loadToken = 0;
  let outputMs = 0; // atraso do som até os ouvidos (caixa, Bluetooth): a letra mostra o que se ouve agora
  // a voz dos microfones da TV na saída (não passa pelo SoundTouch: a troca de tom é da música, não da voz):
  //   cada microfone -> analisador (detector de microfonia) + ganho próprio (a guarda corta só o microfone que apita)
  //   -> soma (volume da voz, igual para todos) -> limitador (vários microfones somados não estouram) -> saída
  let mics = []; // { stream, source, analyser, gain, guard, spectrum }
  let voiceNode = null; // a soma, com o volume da voz
  let limiter = null;
  let voiceGainValue = 0;
  let feedbackTimer = null;

  // --- áudio: <audio> -> SoundTouch (tom) -> saída; sem AudioWorklet (página http fora de localhost) toca sem tom ---
  function ensureGraph() {
    graphReady ??= (async () => {
      ctx = new AudioContext();
      if (!window.isSecureContext || !ctx.audioWorklet) {
        pitchAvailable = false; // AudioWorklet só existe em https ou localhost
        return;
      }
      try {
        await SoundTouchNode.register(ctx, '/vendor/soundtouch/soundtouch-processor.js');
        stNode = new SoundTouchNode({ context: ctx });
        ctx.createMediaElementSource(audio).connect(stNode);
        // o apoio entra na mesma entrada do SoundTouch: os dois mudam de tom juntos
        backingGain = ctx.createGain();
        ctx.createMediaElementSource(backing).connect(backingGain);
        backingGain.connect(stNode);
        stNode.connect(ctx.destination);
        applyPitch();
        applyBacking();
      } catch (err) {
        console.warn('troca de tom indisponível:', err);
        pitchAvailable = false;
        stNode = null;
      }
    })();
    return graphReady;
  }

  function applyVoice() {
    // o volume pedido na soma e, em cada microfone, o fator da guarda; uma rampa curta evita estalo ao cortar
    if (voiceNode) voiceNode.gain.setTargetAtTime(voiceGainValue, ctx.currentTime, 0.02);
    for (const mic of mics) mic.gain.gain.setTargetAtTime(mic.guard.factor, ctx.currentTime, 0.02);
  }

  /** Confere um espectro (dB) de um microfone: se for um apito, corta só a voz dele e avisa. O temporizador chama isto; os testes também. */
  function checkFeedback(spectrumDb, nowMs, index = 0) {
    const mic = mics[index];
    if (!mic) return { factor: 1, triggered: false, hz: null };
    const result = mic.guard.update(spectrumDb, nowMs, ctx?.sampleRate ?? 48000);
    if (result.triggered) {
      applyVoice();
      onFeedback?.({ hz: result.hz, factor: result.factor, mic: index, mics: mics.length });
    } else if (Math.abs(mic.gain.gain.value - result.factor) > 0.01) {
      applyVoice(); // o volume está voltando devagar
    }
    return result;
  }

  function applyPitch() {
    if (stNode) stNode.pitchSemitones.value = pitch;
  }

  // --- vozes de apoio ---
  const backingWanted = () => Boolean(backingUrl) && backingLevel > 0;

  function applyBacking() {
    const level = backingLevel / 100;
    if (backingGain) {
      backingGain.gain.value = level;
      // o volume do ELEMENTO vale antes do grafo de áudio: preso em 0 (como ficava, enquanto o grafo não existia) ele cala o apoio
      backing.volume = 1;
    } else {
      backing.volume = level; // sem o grafo de áudio (http fora de localhost) o volume do próprio elemento faz o papel
    }
    if (!backingWanted()) {
      backing.pause();
      return;
    }
    if (backingLoadedUrl !== backingUrl) {
      backing.src = backingUrl;
      backing.load();
      backingLoadedUrl = backingUrl;
    }
    if (!audio.paused) syncBacking();
  }

  /** Põe o apoio no mesmo ponto do instrumental e o faz tocar junto. */
  function syncBacking() {
    if (!backingWanted()) return;
    backing.currentTime = audio.currentTime;
    if (backing.paused) backing.play().catch(() => {}); // sem o gesto de liberar o som, o instrumental também não toca
  }

  function dropBacking() {
    backing.pause();
    if (backingLoadedUrl) {
      backing.removeAttribute('src');
      backing.load();
      backingLoadedUrl = null;
    }
    backingUrl = null;
  }

  // dois elementos de áudio nunca andam exatamente juntos: de meio em meio segundo o apoio é realinhado se escorregou
  const driftTimer = setInterval(() => {
    if (backingWanted() && !audio.paused && !backing.paused && Math.abs(backing.currentTime - audio.currentTime) > 0.08) {
      backing.currentTime = audio.currentTime;
    }
  }, 500);

  // --- letra: o desenho está em lyrics-view.js; aqui só passa o relógio do áudio ---
  function render() {
    if (itemId !== null) view.render(heardPosition(audio.currentTime, outputMs));
  }

  function loop() {
    render();
    if (!audio.paused) requestAnimationFrame(loop);
  }

  audio.addEventListener('play', () => {
    requestAnimationFrame(loop);
    syncBacking();
  });
  audio.addEventListener('pause', () => {
    backing.pause();
    render();
  });
  audio.addEventListener('seeked', () => {
    if (backingWanted()) backing.currentTime = audio.currentTime;
    render();
  });
  audio.addEventListener('ended', () => onEnded?.(itemId));
  audio.addEventListener('error', () => onError?.(itemId, t('engine.audioFail')));

  return {
    /** Libera o som: precisa ser chamado dentro de um clique (política de autoplay dos navegadores). */
    async unlock() {
      await ensureGraph();
      await ctx.resume();
    },

    /** Carrega um item da fila (lyrics.json + instrumental) sem tocar. */
    async load(item) {
      const token = ++loadToken;
      audio.pause();
      dropBacking();
      backingUrl = item.song.media.backing ?? null;
      backingLevel = clampBacking(item.backing);
      itemId = item.id;
      view.setCues([]);
      view.setOffset(item.lyric_offset ?? 0);
      pitch = clampPitch(item.pitch);
      applyPitch();
      try {
        const res = await fetch(item.song.media.lyrics);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const loaded = await res.json();
        if (token !== loadToken) return; // outra música foi pedida no meio do caminho
        view.setDuet(item.guest?.status === 'accepted'); // dueto: a letra ganha as duas cores
        view.setCues(loaded);
        onLyrics?.(item.id, loaded);
      } catch (err) {
        onError?.(item.id, t('engine.lyricsFail', { error: err.message }));
        return;
      }
      audio.src = item.song.media.instrumental;
      audio.load();
      applyBacking();
      render();
    },

    /** Liga um ou mais microfones (`streams`) na saída de áudio, junto com a música. O volume vem de `setVoiceGain`. */
    async attachVoice(streams) {
      await ensureGraph();
      this.detachVoice();
      if (!voiceNode) {
        voiceNode = ctx.createGain();
        // limitador: dois ou mais cantores somados não podem estourar a saída
        limiter = ctx.createDynamicsCompressor();
        limiter.threshold.value = -6;
        limiter.knee.value = 0;
        limiter.ratio.value = 20;
        limiter.attack.value = 0.003;
        limiter.release.value = 0.1;
        voiceNode.connect(limiter);
        limiter.connect(ctx.destination);
      }
      for (const stream of Array.isArray(streams) ? streams : [streams]) {
        const source = ctx.createMediaStreamSource(stream);
        const gain = ctx.createGain();
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0;
        source.connect(analyser); // o detector escuta ANTES do ganho
        source.connect(gain);
        gain.connect(voiceNode);
        mics.push({ stream, source, analyser, gain, guard: createFeedbackGuard(), spectrum: new Float32Array(analyser.frequencyBinCount) });
      }
      feedbackTimer = setInterval(() => {
        if (voiceGainValue <= 0) return; // voz desligada ou muda: não há apito possível
        mics.forEach((mic, index) => {
          mic.analyser.getFloatFrequencyData(mic.spectrum);
          checkFeedback(mic.spectrum, performance.now(), index);
        });
      }, 50);
      applyVoice();
    },

    /** Desliga a voz e libera os microfones. */
    detachVoice() {
      clearInterval(feedbackTimer);
      feedbackTimer = null;
      for (const mic of mics) {
        mic.analyser.disconnect();
        mic.source.disconnect();
        mic.gain.disconnect();
        for (const track of mic.stream.getTracks()) track.stop();
      }
      mics = [];
    },

    /** Ganho da voz na saída (0 = muda). */
    setVoiceGain(gain) {
      voiceGainValue = Math.max(0, Number(gain) || 0);
      applyVoice();
    },

    async play() {
      await ensureGraph();
      await ctx.resume();
      await audio.play();
    },

    pause() {
      audio.pause();
    },

    /** Vai para um ponto da música (ex.: a TV foi recarregada e retoma de onde estava). */
    seek(seconds) {
      audio.currentTime = Math.max(0, Number(seconds) || 0);
    },

    setPitch(value) {
      pitch = clampPitch(value);
      applyPitch();
    },

    /** Nível das vozes de apoio (0..100 %); só baixa o arquivo quando passa de 0. */
    setBacking(level) {
      const next = clampBacking(level);
      if (next === backingLevel) return;
      backingLevel = next;
      applyBacking();
    },

    setOffset(seconds) {
      view.setOffset(seconds);
      render();
    },

    /** Dueto ligado ou desligado para a música atual (vale também no meio dela). */
    setDuet(on) {
      view.setDuet(on);
      render();
    },

    clear() {
      audio.pause();
      dropBacking();
      itemId = null;
      view.clear();
    },

    get loadedId() { return itemId; },
    get playing() { return !audio.paused; },
    get currentTime() { return audio.currentTime; },
    /** A posição da música que se ouve agora (a que o motor toca, menos o atraso da saída). */
    get heardTime() { return heardPosition(audio.currentTime, outputMs); },
    /** Atraso do som até os ouvidos, em ms: a letra (e a posição que vai aos celulares) acompanham o que se ouve. */
    setOutputLatency(ms) {
      outputMs = Math.max(0, Number(ms) || 0);
      render();
    },
    get duration() { return audio.duration || 0; },
    get pitchAvailable() { return pitchAvailable; },
    get unlocked() { return ctx?.state === 'running'; },
    get pitch() { return pitch; },
    get backingLevel() { return backingLevel; },
    get hasBacking() { return Boolean(backingUrl); },
    get backingPlaying() { return !backing.paused; },
    get backingTime() { return backing.currentTime; },
    /** Diagnóstico do apoio (elemento de áudio e grafo): para entender por que ele não soa. */
    get backingDebug() {
      return {
        readyState: backing.readyState, networkState: backing.networkState, error: backing.error?.code ?? null, paused: backing.paused,
        muted: backing.muted, volume: backing.volume, src: backing.currentSrc, duration: backing.duration,
        gain: backingGain?.gain.value ?? null, ctx: ctx?.state ?? null, graph: Boolean(stNode),
      };
    },
    get voiceAttached() { return mics.length > 0; },
    /** Quantos microfones estão na saída. */
    get voiceMics() { return mics.length; },
    get voiceGain() { return voiceGainValue; },
    /** Quanto a guarda de microfonia deixa passar do volume pedido (1 = tudo; menos = cortado por causa do apito). */
    get voiceFactor() { return mics.length ? Math.min(...mics.map((mic) => mic.guard.factor)) : 1; },
    /** O ganho que está de fato na saída (o pedido vezes o fator da guarda). */
    get voiceOutputGain() { return voiceNode && mics.length ? voiceNode.gain.value * Math.max(...mics.map((mic) => mic.gain.gain.value)) : 0; },
    checkFeedback,
    /** Taxa de amostragem do contexto de áudio (os testes montam espectros no tamanho certo). */
    get sampleRateForTests() { return ctx?.sampleRate ?? 48000; },
    get offset() { return view.offset; },
    get cues() { return view.cues; },
  };
}
