// Motor da TV: toca o instrumental com troca de tom em tempo real e desenha a letra sincronizada.
import { SoundTouchNode } from './vendor/soundtouch/SoundTouchNode.js';
import { clampPitch, gapDisplay, lineProgress, locate, wordFills, wordProgress, wordSpans } from './lyrics-sync.js';

/**
 * @param lyricsEls elementos { prev, current, next, next2 } onde a letra é desenhada
 * @param onEnded   (itemId) => void   chamada quando a música termina
 * @param onError   (itemId, mensagem) => void
 */
export function createEngine({ lyricsEls, onEnded, onError }) {
  const audio = new Audio();
  audio.crossOrigin = 'anonymous';
  audio.preload = 'auto';

  let itemId = null;
  let cues = [];
  let offset = 0;
  let pitch = 0;
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
        await SoundTouchNode.register(ctx, 'vendor/soundtouch/soundtouch-processor.js');
        stNode = new SoundTouchNode({ context: ctx });
        ctx.createMediaElementSource(audio).connect(stNode);
        stNode.connect(ctx.destination);
        applyPitch();
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

  audio.addEventListener('play', () => requestAnimationFrame(loop));
  audio.addEventListener('pause', render);
  audio.addEventListener('seeked', render);
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

    setOffset(seconds) {
      offset = Number(seconds) || 0;
      render();
    },

    clear() {
      audio.pause();
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
    get offset() { return offset; },
  };
}
