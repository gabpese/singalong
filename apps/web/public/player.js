import { SoundTouchNode } from './vendor/soundtouch/SoundTouchNode.js';
import { clampPitch, formatTime, lineProgress, locate, wordProgress, wordSpans } from './lyrics-sync.js';

const $ = (id) => document.getElementById(id);
const els = {
  stage: $('stage'),
  song: $('song'),
  play: $('play'),
  seek: $('seek'),
  time: $('time'),
  duration: $('duration'),
  pitch: $('pitch'),
  pitchOut: $('pitch-out'),
  pitchReset: $('pitch-reset'),
  offset: $('offset'),
  offsetOut: $('offset-out'),
  status: $('status'),
  fullscreen: $('fullscreen'),
  prev: $('l-prev'),
  current: $('l-current'),
  next: $('l-next'),
  next2: $('l-next2'),
};

const audio = new Audio();
audio.crossOrigin = 'anonymous';
audio.preload = 'auto';

let song = null; // meta.json da música carregada
let cues = [];
let ctx = null; // AudioContext (criado no primeiro clique: política de autoplay)
let stNode = null;
let graphReady = null;
let seeking = false;

// --- ajustes salvos por música (conveniência; funciona sem localStorage) ---
const store = {
  get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* sem armazenamento */ }
  },
};

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle('error', isError);
}

// --- grafo de áudio: <audio> -> SoundTouch (pitch) -> saída ---
function ensureGraph() {
  graphReady ??= (async () => {
    ctx = new AudioContext();
    await SoundTouchNode.register(ctx, 'vendor/soundtouch/soundtouch-processor.js');
    stNode = new SoundTouchNode({ context: ctx });
    ctx.createMediaElementSource(audio).connect(stNode);
    stNode.connect(ctx.destination);
    applyPitch();
  })().catch((err) => {
    graphReady = null;
    throw err;
  });
  return graphReady;
}

function applyPitch() {
  const semitones = clampPitch(els.pitch.value);
  els.pitch.value = semitones;
  els.pitchOut.textContent = semitones > 0 ? `+${semitones}` : String(semitones);
  if (stNode) stNode.pitchSemitones.value = semitones;
  if (song) store.set(`pitch:${song.video_id}`, String(semitones));
}

function lyricOffset() {
  return Number(els.offset.value);
}

function applyOffset() {
  const value = lyricOffset();
  els.offsetOut.textContent = `${value.toFixed(2).replace('.', ',')} s`;
  if (song) store.set(`offset:${song.video_id}`, String(value));
}

// --- carregamento da música ---
async function loadSong(meta) {
  audio.pause();
  song = meta;
  cues = [];
  els.play.disabled = true;
  els.seek.disabled = true;
  setStatus('Carregando…');
  const base = `/media/cache/${meta.video_id}`;
  try {
    const res = await fetch(`${base}/lyrics.json`);
    if (!res.ok) throw new Error(`letra: HTTP ${res.status}`);
    cues = await res.json();
  } catch (err) {
    setStatus(`Erro ao carregar a letra: ${err.message}`, true);
    return;
  }
  els.pitch.value = store.get(`pitch:${meta.video_id}`) ?? 0;
  els.offset.value = store.get(`offset:${meta.video_id}`) ?? 0;
  applyPitch();
  applyOffset();
  audio.src = `${base}/instrumental.mp3`;
  audio.load();
  els.play.disabled = false;
  els.seek.disabled = false;
  els.duration.textContent = formatTime(meta.duration);
  setStatus(`${meta.artist ?? ''} — ${meta.title ?? meta.video_id} · letra: ${meta.lyrics_source} (${cues.length} linhas)`);
  render();
}

// --- desenho da letra ---
let lastKey = '';
let words = []; // [{el, span, p}] da linha atual

/** Monta a linha atual com um <span> por palavra (cada um com seu próprio preenchimento). */
function buildCurrentLine(text) {
  els.current.textContent = '';
  words = wordSpans(text).map((span, i) => {
    const el = document.createElement('span');
    el.className = 'w';
    el.textContent = span.word;
    if (i) els.current.append(' ');
    els.current.append(el);
    return { el, span, p: -1 };
  });
}

function paintCurrentLine(lineP) {
  for (const w of words) {
    const p = Math.round(wordProgress(w.span, lineP) * 1000) / 10;
    if (p !== w.p) {
      w.p = p;
      w.el.style.setProperty('--p', `${p}%`);
    }
  }
}

function render() {
  const t = audio.currentTime + lyricOffset();
  const { current, next } = locate(cues, t);
  const text = (i) => cues[i]?.text ?? '';

  // linhas ao redor: se estamos num intervalo (current = -1), "anterior" é a que acabou de passar
  const anchor = current >= 0 ? current : next;
  const key = `${current}|${anchor}`;
  if (key !== lastKey) {
    lastKey = key;
    els.prev.textContent = text(anchor - 1);
    buildCurrentLine(current >= 0 ? text(current) : '');
    els.next.textContent = text(current >= 0 ? current + 1 : next);
    els.next2.textContent = text(current >= 0 ? current + 2 : next + 1);
  }
  paintCurrentLine(current >= 0 ? lineProgress(cues[current], t) : 0);

  els.time.textContent = formatTime(audio.currentTime);
  if (!seeking && audio.duration) els.seek.value = String((audio.currentTime / audio.duration) * 1000);
}

function loop() {
  render();
  if (!audio.paused) requestAnimationFrame(loop);
}

// --- eventos ---
async function togglePlay() {
  if (!song) return;
  if (audio.paused) {
    try {
      await ensureGraph();
      await ctx.resume();
      await audio.play();
    } catch (err) {
      setStatus(`Erro ao tocar: ${err.message}`, true);
    }
  } else {
    audio.pause();
  }
}

audio.addEventListener('play', () => {
  els.play.textContent = '⏸ Pausar';
  requestAnimationFrame(loop);
});
audio.addEventListener('pause', () => {
  els.play.textContent = '▶ Tocar';
  render();
});
audio.addEventListener('ended', () => {
  els.play.textContent = '▶ Tocar';
});
audio.addEventListener('seeked', render);
audio.addEventListener('error', () => setStatus('Erro ao carregar o áudio.', true));
audio.addEventListener('loadedmetadata', () => {
  els.duration.textContent = formatTime(audio.duration);
});

els.play.addEventListener('click', togglePlay);
els.pitch.addEventListener('input', applyPitch);
els.pitchReset.addEventListener('click', () => {
  els.pitch.value = 0;
  applyPitch();
});
els.offset.addEventListener('input', () => {
  applyOffset();
  render();
});
els.seek.addEventListener('input', () => {
  seeking = true;
  if (audio.duration) audio.currentTime = (Number(els.seek.value) / 1000) * audio.duration;
  render();
});
els.seek.addEventListener('change', () => { seeking = false; });
els.fullscreen.addEventListener('click', toggleFullscreen);

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else els.stage.requestFullscreen?.();
}

document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLSelectElement) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
    e.preventDefault();
    els.pitch.value = clampPitch(Number(els.pitch.value) + (e.key === 'ArrowUp' ? 1 : -1));
    applyPitch();
  } else if (e.key === 'f' || e.key === 'F') toggleFullscreen();
});

// --- lista de músicas ---
async function init() {
  let songs = [];
  try {
    songs = await (await fetch('/api/songs')).json();
  } catch (err) {
    setStatus(`Erro ao listar músicas: ${err.message}`, true);
    return;
  }
  if (!songs.length) {
    els.song.innerHTML = '<option>Nenhuma música no cache</option>';
    setStatus('Processe uma música com o worker (veja o README) e recarregue.', true);
    return;
  }
  for (const s of songs) {
    const opt = document.createElement('option');
    opt.value = s.video_id;
    opt.textContent = `${s.artist ?? '?'} — ${s.title ?? s.video_id}`;
    els.song.append(opt);
  }
  els.song.addEventListener('change', () => loadSong(songs.find((s) => s.video_id === els.song.value)));
  await loadSong(songs[0]);
}

// gancho de diagnóstico (testes no navegador)
window.singalong = {
  get pitchSemitones() { return stNode?.pitchSemitones.value ?? null; },
  get metrics() { return stNode?.metrics ?? null; },
  get contextState() { return ctx?.state ?? null; },
};

init();
