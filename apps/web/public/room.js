// Controle da sala (celular): fila, o que está tocando, adicionar músicas e ações de anfitrião.
import { initAddPanel } from './add-song.js';
import {
  api, connectRoom, hostToken, parseHostHash, parseRoomCode, setHostToken, setUserName, userName,
} from './identity.js';
import { describeLyricsSource } from './lyrics-sync.js';
import {
  formatDuration, formatPitch, progressPercent, songChip, splitQueue, thumbnailUrl,
} from './queue-view.js';

const $ = (id) => document.getElementById(id);

/** Cria elementos sem innerHTML: títulos e nomes vêm de terceiros, então sempre viram texto. */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (value === true) el.setAttribute(key, '');
    else if (value !== false && value != null) el.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child != null && child !== false) el.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return el;
}

const code = parseRoomCode(location.search);
if (!code) {
  location.replace('/');
  throw new Error('sala não informada');
}

// link de anfitrião (#host=TOKEN): guarda o token e tira da barra de endereço
const fromLink = parseHostHash(location.hash);
if (fromLink) {
  setHostToken(code, fromLink);
  history.replaceState(null, '', location.pathname + location.search);
}

const els = {
  roomCode: $('room-code'),
  tvStatus: $('tv-status'),
  openTv: $('open-tv'),
  copyLink: $('copy-link'),
  copyHost: $('copy-host'),
  userName: $('user-name'),
  nowBody: $('now-body'),
  queue: $('queue'),
  queueCount: $('queue-count'),
  queueEmpty: $('queue-empty'),
  libraryList: $('library-list'),
  libraryEmpty: $('library-empty'),
  library: $('library'),
  hostSettings: $('host-settings'),
  fair: $('fair'),
  toast: $('toast'),
};

els.roomCode.textContent = code;
document.title = `Singalong — Sala ${code}`;
els.userName.value = userName();
els.userName.addEventListener('input', () => setUserName(els.userName.value));

let state = null;
let connected = false;
let position = { ms: 0, at: performance.now(), itemId: null };
let nowRefs = null; // elementos que o relógio de progresso atualiza
let toastTimer = null;
let lastReadyKey = '';

const isHost = () => Boolean(state?.me?.is_host);
const myName = () => els.userName.value.trim() || 'Alguém';

function toast(text, isError = false) {
  clearTimeout(toastTimer);
  els.toast.textContent = text;
  els.toast.classList.toggle('error', isError);
  els.toast.classList.add('show');
  toastTimer = setTimeout(() => els.toast.classList.remove('show'), 3500);
}

async function copyText(text, okMessage) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMessage);
  } catch {
    window.prompt('Copie o link:', text); // navegador sem permissão de área de transferência (http fora de localhost)
  }
}

/** Ação na sala; o estado devolvido já atualiza a tela (o WebSocket confirma para todos). */
async function act(method, path, body) {
  try {
    const result = await api(method, `/api/rooms/${code}${path}`, body, code);
    if (result.state?.queue) {
      state = result.state;
      render();
    }
    return result;
  } catch (err) {
    toast(err.message, true);
    throw err;
  }
}

// --- desenho ---
function pitchControl(item) {
  const set = (value) => act('PATCH', `/queue/${item.id}`, { pitch: Math.max(-6, Math.min(6, value)) }).catch(() => {});
  if (!item.can_edit) return item.pitch ? h('span', { class: 'pitch static' }, `Tom ${formatPitch(item.pitch)}`) : null;
  return h('span', { class: 'pitch', title: 'Tom da música (semitons)' },
    h('button', { type: 'button', 'aria-label': 'Tom mais grave', onclick: () => set(item.pitch - 1), disabled: item.pitch <= -6 }, '−'),
    h('span', { class: 'pitch-value' }, `Tom ${formatPitch(item.pitch)}`),
    h('button', { type: 'button', 'aria-label': 'Tom mais agudo', onclick: () => set(item.pitch + 1), disabled: item.pitch >= 6 }, '+'));
}

function renderNow(current) {
  els.nowBody.textContent = '';
  nowRefs = null;
  if (!current) {
    const waiting = state.queue.length;
    els.nowBody.append(h('p', { class: 'hint' }, waiting
      ? 'Preparando a próxima música… ela começa sozinha quando estiver pronta.'
      : 'Nada tocando. Adicione uma música abaixo.'));
    return;
  }
  const bar = h('div', { class: 'bar' });
  const time = h('span', { class: 'time' });
  nowRefs = { bar, time, duration: current.song.duration };

  // um único filho: o `append` do DOM transformaria os `null` das partes opcionais no texto "null"
  els.nowBody.append(h('div', { class: 'now-content' },
    h('div', { class: 'now-main' },
      h('img', { src: thumbnailUrl(current.video_id), alt: '', class: 'thumb' }),
      h('div', { class: 'now-info' },
        h('strong', {}, current.title ?? current.video_id),
        current.artist ? h('span', { class: 'muted' }, current.artist) : null,
        h('span', { class: 'singer' }, `Cantando: ${current.added_by}`),
        h('span', { class: 'muted small' }, `Letra: ${describeLyricsSource(current.song.lyrics_source)}`))),
    h('div', { class: 'progress' }, h('div', { class: 'track' }, bar), time),
    h('div', { class: 'controls-row' },
      isHost() ? [
        h('button', { type: 'button', onclick: () => act('POST', `/player/${state.playback === 'paused' ? 'resume' : 'pause'}`).catch(() => {}) },
          state.playback === 'paused' ? '▶ Retomar' : '⏸ Pausar'),
        h('button', { type: 'button', onclick: () => act('POST', '/player/skip').catch(() => {}) }, '⏭ Pular'),
      ] : null,
      pitchControl(current)),
    isHost() ? h('div', { class: 'controls-row offset' },
      h('span', { class: 'muted' }, 'Ajuste da letra'),
      [-0.5, -0.1, 0.1, 0.5].map((step) =>
        h('button', {
          type: 'button',
          onclick: () => act('PUT', `/songs/${current.video_id}/offset`, { offset: Math.round((current.lyric_offset + step) * 100) / 100 }).catch(() => {}),
        }, `${step > 0 ? '+' : '−'}${Math.abs(step)} s`)),
      h('span', { class: 'offset-value' }, `${current.lyric_offset.toFixed(1).replace('.', ',')} s`)) : null,
    !state.tv_connected ? h('p', { class: 'hint error' }, 'A TV não está conectada: clique em “Abrir TV” (ou abra o link da TV) para a música tocar.') : null,
  ));
  updateProgress();
}

function updateProgress() {
  if (!nowRefs) return;
  const { current } = splitQueue(state);
  const elapsed = state.playback === 'playing' ? performance.now() - position.at : 0;
  const ms = position.itemId === current?.id ? position.ms + elapsed : 0;
  nowRefs.bar.style.width = `${progressPercent(ms, nowRefs.duration)}%`;
  nowRefs.time.textContent = `${formatDuration(ms / 1000)}${nowRefs.duration ? ` / ${formatDuration(nowRefs.duration)}` : ''}`;
}

function queueItem(item, index, waiting) {
  const chip = songChip(item.song);
  const info = h('div', { class: 'info' },
    h('strong', {}, item.title ?? item.video_id),
    h('span', { class: 'muted' }, [item.artist, `por ${item.added_by}`].filter(Boolean).join(' · ')),
    h('span', { class: `chip ${chip.kind}` }, chip.label),
    item.song.status === 'needs_lyrics' || item.song.status === 'failed'
      ? h('span', { class: 'muted small' }, item.song.error ?? '') : null);

  const actions = h('div', { class: 'actions' },
    item.song.status === 'needs_lyrics' && item.can_edit
      ? h('button', { type: 'button', onclick: () => panel.chooseLyrics(item.video_id, item.song.error) }, 'Escolher letra') : null,
    item.song.status === 'failed' && item.can_edit
      ? h('button', {
        type: 'button',
        onclick: async () => {
          try {
            await api('POST', '/api/songs', { url: `https://www.youtube.com/watch?v=${item.video_id}` }, code);
            toast('Tentando de novo…');
          } catch (err) {
            toast(err.message, true);
          }
        },
      }, 'Tentar de novo') : null,
    pitchControl(item),
    isHost() ? [
      h('button', { type: 'button', 'aria-label': 'Subir na fila', disabled: index === 0, onclick: () => act('POST', `/queue/${item.id}/move`, { direction: 'up' }).catch(() => {}) }, '▲'),
      h('button', { type: 'button', 'aria-label': 'Descer na fila', disabled: index === waiting.length - 1, onclick: () => act('POST', `/queue/${item.id}/move`, { direction: 'down' }).catch(() => {}) }, '▼'),
    ] : null,
    item.can_edit
      ? h('button', { type: 'button', class: 'danger', 'aria-label': 'Remover da fila', onclick: () => act('DELETE', `/queue/${item.id}`).catch(() => {}) }, '✕') : null);

  return h('li', { class: `queue-item${item.mine ? ' mine' : ''}` },
    h('span', { class: 'rank' }, index + 1),
    h('img', { src: thumbnailUrl(item.video_id), alt: '', class: 'thumb', loading: 'lazy' }),
    info,
    actions);
}

function render() {
  if (!state) return;
  const { current, waiting } = splitQueue(state);

  els.tvStatus.textContent = !connected ? 'Reconectando à sala…' : state.tv_connected ? '📺 TV conectada' : 'TV desconectada — clique em “Abrir TV”';
  els.tvStatus.classList.toggle('on', connected && state.tv_connected);
  els.copyHost.hidden = !isHost();
  els.hostSettings.hidden = !isHost();
  els.fair.checked = state.fair;

  renderNow(current);

  els.queue.textContent = '';
  waiting.forEach((item, i) => els.queue.append(queueItem(item, i, waiting)));
  els.queueCount.textContent = waiting.length ? `(${waiting.length})` : '';
  els.queueEmpty.hidden = waiting.length > 0;
}

// --- biblioteca (músicas já processadas) ---
async function loadLibrary() {
  let songs = [];
  try {
    songs = await api('GET', '/api/songs');
  } catch {
    return;
  }
  els.libraryList.textContent = '';
  els.libraryEmpty.hidden = songs.length > 0;
  for (const song of songs) {
    els.libraryList.append(h('li', {},
      h('img', { src: thumbnailUrl(song.video_id), alt: '', class: 'thumb', loading: 'lazy' }),
      h('div', { class: 'info' },
        h('strong', {}, song.title ?? song.video_id),
        h('span', { class: 'muted' }, [song.artist, song.duration ? formatDuration(song.duration) : null].filter(Boolean).join(' · '))),
      h('button', {
        type: 'button',
        onclick: async () => {
          try {
            await act('POST', '/queue', { video_id: song.video_id, name: myName(), display_title: song.title ?? undefined });
            toast('Adicionada à fila!');
          } catch {
            // o erro já apareceu no aviso
          }
        },
      }, 'Adicionar à fila')));
  }
}

/** Recarrega a biblioteca quando alguma música da fila termina de processar. */
function refreshLibraryIfNeeded() {
  const key = state.queue.filter((i) => i.song.ready).map((i) => i.video_id).sort().join(',');
  if (key !== lastReadyKey) {
    lastReadyKey = key;
    loadLibrary();
  }
}

// --- painel de adicionar ---
const panel = initAddPanel({
  async submitNew(body) {
    const result = await act('POST', '/queue', { ...body, name: myName() });
    loadLibrary();
    if (result.cached) return 'Adicionada à fila (essa música já estava pronta).';
    if (result.deduped) return 'Adicionada à fila (essa música já estava sendo preparada).';
    return 'Adicionada à fila! Ela está sendo preparada e toca quando chegar a vez.';
  },
  async submitLyrics(videoId, body) {
    await api('PUT', `/api/songs/${videoId}/lyrics`, body, code);
    return 'Letra enviada. A música volta a ser preparada.';
  },
});

// --- botões do topo e do anfitrião ---
els.openTv.addEventListener('click', () => window.open(`tv.html?room=${code}`, '_blank'));
els.copyLink.addEventListener('click', () => copyText(`${location.origin}/room.html?room=${code}`, 'Link da sala copiado!'));
els.copyHost.addEventListener('click', () =>
  copyText(`${location.origin}/room.html?room=${code}#host=${hostToken(code)}`, 'Link de anfitrião copiado! Quem abrir controla a sala.'));
els.fair.addEventListener('change', () => act('PATCH', '', { fair: els.fair.checked }).catch(() => { els.fair.checked = !els.fair.checked; }));
els.library.addEventListener('toggle', () => els.library.open && loadLibrary());

// --- tempo real ---
connectRoom(code, 'controller', {
  onMessage(message) {
    if (message.type === 'state') {
      state = message.state;
      position = { ms: state.position_ms, at: performance.now(), itemId: state.current_item_id };
      render();
      refreshLibraryIfNeeded();
    } else if (message.type === 'position' && state) {
      position = { ms: message.ms, at: performance.now(), itemId: message.item_id };
      updateProgress();
    }
  },
  onStatus(status) {
    connected = status === 'connected';
    if (state) render();
    else els.tvStatus.textContent = connected ? 'Conectado' : 'Reconectando à sala…';
  },
  onGone() {
    document.querySelector('.room-page').replaceChildren(
      h('h1', {}, 'Sala não encontrada'),
      h('p', {}, `A sala ${code} não existe mais (salas paradas há 24 horas são apagadas).`),
      h('a', { href: '/', class: 'button primary' }, 'Criar uma nova sala'));
  },
});

setInterval(updateProgress, 500);
loadLibrary();

// gancho de diagnóstico (testes no navegador)
window.room = { get state() { return state; } };
