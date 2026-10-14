// Motor da TV: toca o instrumental (e, se houver, as vozes de apoio) com troca de tom em tempo real e desenha a letra sincronizada.
import { t } from '../i18n/index.js';
import { SoundTouchNode } from '../vendor/soundtouch/SoundTouchNode.js';
import { createFeedbackGuard } from './feedback.js';
import { blockRms, createGate, GATE } from './voice-gate.js';
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
  // trilhas extras, no mesmo ponto do instrumental e com o volume que quem escolheu a música definiu:
  // as vozes de apoio (backing) e a voz original isolada, como guia para cantar (guide)
  function createStem() {
    const element = new Audio();
    element.crossOrigin = 'anonymous';
    element.preload = 'auto';
    return {
      element,
      url: null, // o arquivo da música atual (null = a música não tem)
      level: 0, // 0..100 (%)
      loadedUrl: null, // o que o elemento de áudio já carregou (só baixa quando o nível passa de 0)
      gain: null,
    };
  }
  const backing = createStem();
  const guide = createStem();
  const stems = [backing, guide];

  let itemId = null;
  const view = createLyricsView(lyricsEls);
  let pitch = 0;
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
  let voiceFilterOn = true; // filtro de graves e portão de ruído na voz
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
        // as trilhas extras entram na mesma entrada do SoundTouch: todas mudam de tom juntas
        for (const stem of stems) {
          stem.gain = ctx.createGain();
          ctx.createMediaElementSource(stem.element).connect(stem.gain);
          stem.gain.connect(stNode);
        }
        stNode.connect(ctx.destination);
        applyPitch();
        stems.forEach(applyStem);
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

  /** O portão de ruído de um microfone: com o volume (RMS) e o instante, abre ou fecha. O temporizador chama isto; os testes também. */
  function stepGate(rms, nowMs, index = 0) {
    const mic = mics[index];
    if (!mic) return 1;
    const target = voiceFilterOn ? mic.noiseGate.target(rms, nowMs) : 1;
    // abre depressa (a primeira sílaba não pode ser cortada) e fecha devagar (sem "pumping" a cada respiração)
    mic.gate.gain.setTargetAtTime(target, ctx.currentTime, target === 1 ? 0.01 : 0.12);
    return target;
  }

  function applyPitch() {
    if (stNode) stNode.pitchSemitones.value = pitch;
  }

  // --- trilhas extras (vozes de apoio e voz original) ---
  const stemWanted = (stem) => Boolean(stem.url) && stem.level > 0;

  function applyStem(stem) {
    const level = stem.level / 100;
    if (stem.gain) {
      stem.gain.gain.value = level;
      // o volume do ELEMENTO vale antes do grafo de áudio: preso em 0 (como ficava, enquanto o grafo não existia) ele cala a trilha
      stem.element.volume = 1;
    } else {
      stem.element.volume = level; // sem o grafo de áudio (http fora de localhost) o volume do próprio elemento faz o papel
    }
    if (!stemWanted(stem)) {
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

  /** Põe a trilha no mesmo ponto do instrumental e a faz tocar junto. */
  function syncStem(stem) {
    if (!stemWanted(stem)) return;
    stem.element.currentTime = audio.currentTime;
    if (stem.element.paused) stem.element.play().catch(() => {}); // sem o gesto de liberar o som, o instrumental também não toca
  }

  function dropStem(stem) {
    stem.element.pause();
    if (stem.loadedUrl) {
      stem.element.removeAttribute('src');
      stem.element.load();
      stem.loadedUrl = null;
    }
    stem.url = null;
  }

  // dois elementos de áudio nunca andam exatamente juntos: de meio em meio segundo cada trilha é realinhada se escorregou
  const driftTimer = setInterval(() => {
    for (const stem of stems) {
      if (stemWanted(stem) && !audio.paused && !stem.element.paused && Math.abs(stem.element.currentTime - audio.currentTime) > 0.08) {
        stem.element.currentTime = audio.currentTime;
      }
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
    /** Libera o som: precisa ser chamado dentro de um clique (política de autoplay dos navegadores). */
    async unlock() {
      await ensureGraph();
      await ctx.resume();
    },

    /** Carrega um item da fila (lyrics.json + instrumental) sem tocar. */
    async load(item) {
      const token = ++loadToken;
      audio.pause();
      stems.forEach(dropStem);
      backing.url = item.song.media.backing ?? null;
      backing.level = clampBacking(item.backing);
      guide.url = item.song.media.vocals ?? null;
      guide.level = clampBacking(item.guide);
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
        view.setDuet(item.guest?.status === 'accepted', item.parts); // dueto: a letra ganha as duas cores (a divisão dos cantores, se houver)
        view.setCues(loaded);
        onLyrics?.(item.id, loaded);
      } catch (err) {
        onError?.(item.id, t('engine.lyricsFail', { error: err.message }));
        return;
      }
      audio.src = item.song.media.instrumental;
      audio.load();
      stems.forEach(applyStem);
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
        const highpass = ctx.createBiquadFilter(); // tira o estrondo e o ruído de manuseio
        highpass.type = 'highpass';
        highpass.Q.value = 0.7;
        highpass.frequency.value = voiceFilterOn ? GATE.filterHz : 10;
        const gate = ctx.createGain(); // o portão de ruído: fecha quando ninguém canta
        const gain = ctx.createGain(); // o ganho da guarda de microfonia
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0;
        source.connect(analyser); // o detector de microfonia e o portão escutam o microfone ANTES de tudo
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
        if (voiceGainValue <= 0) return; // voz desligada ou muda: não há apito possível
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

    /** Liga ou desliga o filtro de graves e o portão de ruído da voz (valem na hora, também com a voz já ligada). */
    setVoiceFilter(on) {
      voiceFilterOn = Boolean(on);
      for (const mic of mics) {
        mic.highpass.frequency.value = voiceFilterOn ? GATE.filterHz : 10;
        if (!voiceFilterOn) mic.gate.gain.setTargetAtTime(1, ctx.currentTime, 0.01);
      }
    },
    stepGate,

    /** Desliga a voz e libera os microfones. */
    detachVoice() {
      clearInterval(feedbackTimer);
      feedbackTimer = null;
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
      if (next === backing.level) return;
      backing.level = next;
      applyStem(backing);
    },

    /** Nível da voz original, como guia (0..100 %); só baixa o arquivo quando passa de 0. */
    setGuide(level) {
      const next = clampBacking(level);
      if (next === guide.level) return;
      guide.level = next;
      applyStem(guide);
    },

    setOffset(seconds) {
      view.setOffset(seconds);
      render();
    },

    /**
     * Dueto ligado ou desligado para a música atual (vale também no meio dela).
     * @param {boolean} on
     * @param {string | null} [chosen] a divisão escolhida pelos cantores (texto a b * -)
     */
    setDuet(on, chosen = null) {
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
    get backingLevel() { return backing.level; },
    get hasBacking() { return Boolean(backing.url); },
    get backingPlaying() { return !backing.element.paused; },
    get backingTime() { return backing.element.currentTime; },
    get guideLevel() { return guide.level; },
    get hasGuide() { return Boolean(guide.url); },
    get guidePlaying() { return !guide.element.paused; },
    get guideTime() { return guide.element.currentTime; },
    /** Diagnóstico do apoio (elemento de áudio e grafo): para entender por que ele não soa. */
    get backingDebug() {
      return {
        readyState: backing.element.readyState, networkState: backing.element.networkState, error: backing.element.error?.code ?? null, paused: backing.element.paused,
        muted: backing.element.muted, volume: backing.element.volume, src: backing.element.currentSrc, duration: backing.element.duration,
        gain: backing.gain?.gain.value ?? null, ctx: ctx?.state ?? null, graph: Boolean(stNode),
      };
    },
    get voiceAttached() { return mics.length > 0; },
    /** Quantos microfones estão na saída. */
    get voiceMics() { return mics.length; },
    get voiceFilter() { return voiceFilterOn; },
    /** O ganho do portão de ruído do primeiro microfone (1 = aberto). */
    get voiceGateGain() { return mics[0] ? mics[0].gate.gain.value : 1; },
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
