// Motor da TV: toca o instrumental (e, se houver, as vozes de apoio) com troca de tom em tempo real e desenha a letra sincronizada.
import { SoundTouchNode } from '../vendor/soundtouch/SoundTouchNode.js';
import { clampBacking, clampPitch, gapDisplay, lineProgress, locate, wordFills, wordProgress, wordSpans } from './lyrics-sync.js';

/**
 * @param lyricsEls elementos { prev, current, next, next2 } onde a letra é desenhada
 * @param onEnded   (itemId) => void   chamada quando a música termina
 * @param onError   (itemId, mensagem) => void
 */
export function createEngine({ lyricsEls, onEnded, onError }) {
  const audio = new Audio();
  audio.crossOrigin = 'anonymous';
  audio.preload = 'auto';
  // vozes de apoio: um segundo áudio, no mesmo ponto do instrumental, com o volume que quem escolheu a música definiu
  const backing = new Audio();
  backing.crossOrigin = 'anonymous';
  backing.preload = 'auto';

  let itemId = null;
  let cues = [];
  let offset = 0;
  let pitch = 0;
  let backingUrl = null; // as vozes de apoio da música atual (null = a música não tem)
  let backingLevel = 0; // 0..100 (%)
  let backingLoadedUrl = null; // o que o elemento de áudio já carregou (só baixa quando o nível passa de 0)
  let backingGain = null;
  let ctx = null;
  let stNode = null;
  let graphReady = null;
  let pitchAvailable = true;
  let lastKey = '';
  let words = []; // [{el, span, p}] da linha atual
  let gapEl = null; // o aviso de pausa longa, quando está na tela
  let lastDashes = -1;
  let loadToken = 0;

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

  // --- letra ---
  function clearLyrics() {
    for (const el of [lyricsEls.prev, lyricsEls.current, lyricsEls.next, lyricsEls.next2]) el.textContent = '';
    words = [];
    lastKey = '';
  }

  /** Monta a linha atual com um <span> por palavra (cada um com seu preenchimento: a quebra de linha não importa). */
  function buildCurrentLine(text) {
    lyricsEls.current.textContent = '';
    words = wordSpans(text).map((span, i) => {
      const el = document.createElement('span');
      el.className = 'w';
      el.textContent = span.word;
      if (i) lyricsEls.current.append(' ');
      lyricsEls.current.append(el);
      return { el, span, p: -1 };
    });
  }

  function paintCurrentLine(lineP, fills) {
    words.forEach((w, i) => {
      const p = Math.round((fills ? fills[i] : wordProgress(w.span, lineP)) * 1000) / 10;
      if (p !== w.p) {
        w.p = p;
        w.el.style.setProperty('--p', `${p}%`);
      }
    });
  }

  /** Pausa longa na letra: no lugar da linha atual, "--------------" que some nos últimos 8 s (prepare-se!). */
  function buildGapLine() {
    lyricsEls.current.textContent = '';
    gapEl = document.createElement('span');
    gapEl.className = 'gap-dashes';
    lyricsEls.current.append(gapEl);
    words = [];
    lastDashes = -1;
  }

  function paintGap(dashes) {
    if (dashes === lastDashes) return;
    lastDashes = dashes;
    gapEl.textContent = '-'.repeat(dashes);
  }

  function render() {
    if (itemId === null) return;
    const t = audio.currentTime + offset;
    const gap = gapDisplay(cues, t);
    let { current, next } = locate(cues, t);
    if (gap) {
      current = -1; // dentro de uma pausa longa nenhuma linha está sendo cantada, mesmo que o `end` da anterior diga o contrário
      next = gap.next;
    }
    const text = (i) => cues[i]?.text ?? '';
    const anchor = current >= 0 ? current : next;
    const key = `${current}|${anchor}|${gap ? 'gap' : ''}`;
    if (key !== lastKey) {
      lastKey = key;
      lyricsEls.prev.textContent = text(anchor - 1);
      if (gap) buildGapLine();
      else buildCurrentLine(current >= 0 ? text(current) : cues.length ? '' : '♪ Sem letra para esta música');
      lyricsEls.next.textContent = text(current >= 0 ? current + 1 : next);
      lyricsEls.next2.textContent = text(current >= 0 ? current + 2 : next + 1);
    }
    if (gap) paintGap(gap.dashes);
    else paintCurrentLine(current >= 0 ? lineProgress(cues[current], t) : 0, current >= 0 ? wordFills(cues[current], words.length, t) : null);
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
      cues = [];
      clearLyrics();
      offset = item.lyric_offset ?? 0;
      pitch = clampPitch(item.pitch);
      applyPitch();
      try {
        const res = await fetch(item.song.media.lyrics);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const loaded = await res.json();
        if (token !== loadToken) return; // outra música foi pedida no meio do caminho
        cues = loaded;
      } catch (err) {
        onError?.(item.id, `Não consegui carregar a letra (${err.message}).`);
        return;
      }
      audio.src = item.song.media.instrumental;
      audio.load();
      applyBacking();
      render();
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
      offset = Number(seconds) || 0;
      render();
    },

    clear() {
      audio.pause();
      dropBacking();
      itemId = null;
      cues = [];
      clearLyrics();
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
    get offset() { return offset; },
  };
}
