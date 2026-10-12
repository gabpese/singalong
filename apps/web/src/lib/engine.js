// Motor da TV: toca o instrumental (e, se houver, as vozes de apoio) com troca de tom em tempo real e desenha a letra sincronizada.
import { SoundTouchNode } from '../vendor/soundtouch/SoundTouchNode.js';
import { clampBacking, clampPitch } from './lyrics-sync.js';
import { createLyricsView } from './lyrics-view.js';

/**
 * @param lyricsEls elementos { prev, current, next, next2 } onde a letra é desenhada
 * @param onEnded   (itemId) => void   chamada quando a música termina
 * @param onError   (itemId, mensagem) => void
 * @param onLyrics  (itemId, linhas) => void   a letra da música carregou (a TV a repassa ao palco dos cantores)
 */
export function createEngine({ lyricsEls, onEnded, onError, onLyrics }) {
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
  // a voz do microfone da TV na saída: microfone -> ganho -> saída (não passa pelo SoundTouch: a troca de tom é da música, não da voz)
  let voiceStream = null;
  let voiceSource = null;
  let voiceNode = null;
  let voiceGainValue = 0;

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
    if (voiceNode) voiceNode.gain.value = voiceGainValue;
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
    if (itemId !== null) view.render(audio.currentTime);
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
  audio.addEventListener('error', () => onError?.(itemId, 'Não consegui carregar o áudio.'));

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
        view.setCues(loaded);
        onLyrics?.(item.id, loaded);
      } catch (err) {
        onError?.(item.id, `Não consegui carregar a letra (${err.message}).`);
        return;
      }
      audio.src = item.song.media.instrumental;
      audio.load();
      applyBacking();
      render();
    },

    /** Liga o microfone (`stream`) na saída de áudio, junto com a música. O volume vem de `setVoiceGain`. */
    async attachVoice(stream) {
      await ensureGraph();
      this.detachVoice();
      voiceStream = stream;
      voiceSource = ctx.createMediaStreamSource(stream);
      voiceNode ??= ctx.createGain();
      voiceSource.connect(voiceNode);
      voiceNode.connect(ctx.destination);
      applyVoice();
    },

    /** Desliga a voz e libera o microfone. */
    detachVoice() {
      voiceSource?.disconnect();
      voiceSource = null;
      for (const track of voiceStream?.getTracks() ?? []) track.stop();
      voiceStream = null;
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

    clear() {
      audio.pause();
      dropBacking();
      itemId = null;
      view.clear();
    },

    get loadedId() { return itemId; },
    get playing() { return !audio.paused; },
    get currentTime() { return audio.currentTime; },
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
    get voiceAttached() { return voiceStream !== null; },
    get voiceGain() { return voiceGainValue; },
    get offset() { return view.offset; },
    get cues() { return view.cues; },
  };
}
