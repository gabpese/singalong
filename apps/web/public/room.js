// Controle da sala (celular): fila, o que está tocando, adicionar músicas, prévia e ações de anfitrião.
import { initAddPanel } from './add-song.js';
import { downloadFile, EXPORT_PITCHES, exportFileName, requestExport } from './export-mp4.js';
import { icon } from './icons.js';
import {
  api, connectRoom, hostToken, parseHostHash, parseRoomCode, setHostToken, setUserName, userName,
} from './identity.js';
import { describeLyricsSource } from './lyrics-sync.js';
import { keySummary } from './music.js';
import { createPreviewPlayer } from './preview.js';
import {
  canRetry, filterSongs, formatDuration, formatPitch, nextUp, progressPercent, songChip, sortSongs, playOrder, splitQueue, thumbnailUrl,
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
  menu: $('menu'),
  openTv: $('open-tv'),
  copyLink: $('copy-link'),
  copyHost: $('copy-host'),
  userName: $('user-name'),
  nowBody: $('now-body'),
  queue: $('queue'),
  queueCount: $('queue-count'),
  queueEmpty: $('queue-empty'),
  tabCount: $('tab-count'),
  libraryList: $('library-list'),
  libraryEmpty: $('library-empty'),
  libraryEmptyText: $('library-empty-text'),
  libraryClear: $('library-clear'),
  libraryFilter: $('library-filter'),
  libraryCount: $('library-count'),
  hostSettings: $('host-settings'),
  fair: $('fair'),
  scoring: $('scoring'),
  hostScoring: $('host-scoring'),
  scoreboardCard: $('scoreboard-card'),
  scoreboard: $('scoreboard'),
  toast: $('toast'),
  previewBar: $('preview-bar'),
  previewTitle: $('preview-title'),
  previewKey: $('preview-key'),
  previewPlay: $('preview-play'),
  previewSeek: $('preview-seek'),
  previewPitch: $('preview-pitch'),
  previewHint: $('preview-hint'),
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

// --- abas (celular) ---
function showTab(name) {
  document.querySelectorAll('.tab').forEach((section) => { section.hidden = section.dataset.tab !== name; });
  document.querySelectorAll('.tabbar [data-go]').forEach((button) => button.classList.toggle('active', button.dataset.go === name));
  window.scrollTo({ top: 0 });
}
document.querySelectorAll('.tabbar [data-go]').forEach((button) => button.addEventListener('click', () => showTab(button.dataset.go)));

// --- prévia do instrumental (com tom) ---
const preview = createPreviewPlayer({ onEnded: () => syncPreviewUi() });
let previewItem = null; // { id, video_id, can_edit, key }
let previewPitch = 0;

function syncPreviewUi() {
  // U+FE0E força o símbolo em texto: sem ele alguns celulares desenham o emoji colorido
  els.previewPlay.textContent = preview.playing ? '⏸︎' : '▶︎';
  els.previewPitch.textContent = `Tom ${formatPitch(previewPitch)}`;
  els.previewKey.textContent = previewItem ? keySummary(previewItem.key, previewPitch) : '';
  if (preview.duration && !els.previewSeek.matches(':active')) {
    els.previewSeek.value = String(Math.round((preview.position / preview.duration) * 1000));
  }
}

function closePreview() {
  preview.unload();
  previewItem = null;
  els.previewBar.hidden = true;
  document.body.classList.remove('has-preview');
}

async function openPreview(item) {
  previewItem = { id: item.id, video_id: item.video_id, can_edit: item.can_edit, key: item.song.key };
  previewPitch = item.pitch;
  preview.setPitch(previewPitch);
  els.previewTitle.textContent = item.title ?? item.video_id;
  els.previewHint.textContent = 'Carregando a música…';
  els.previewSeek.value = '0';
  els.previewBar.hidden = false;
  document.body.classList.add('has-preview');
  syncPreviewUi();
  try {
    if (!(await preview.load(item.song.media.instrumental))) return; // outra prévia foi pedida
    await preview.play();
    els.previewHint.textContent = item.can_edit
      ? 'Mudar o tom aqui muda o tom da sua música na fila.'
      : 'Esta música é de outra pessoa: o tom aqui vale só para a sua prévia.';
  } catch (err) {
    els.previewHint.textContent = `Não consegui tocar a prévia: ${err.message}`;
  }
  syncPreviewUi();
}

function stepPreviewPitch(delta) {
  if (!previewItem) return;
  previewPitch = Math.max(-6, Math.min(6, previewPitch + delta));
  preview.setPitch(previewPitch);
  syncPreviewUi();
  if (previewItem.can_edit) act('PATCH', `/queue/${previewItem.id}`, { pitch: previewPitch }).catch(() => {});
}

$('preview-play').addEventListener('click', async () => {
  if (!preview.loaded) return;
  if (preview.playing) preview.pause();
  else await preview.play();
  syncPreviewUi();
});
$('preview-seek').addEventListener('input', (e) => preview.seek(Number(e.target.value) / 1000));
$('preview-up').addEventListener('click', () => stepPreviewPitch(1));
$('preview-down').addEventListener('click', () => stepPreviewPitch(-1));
$('preview-close').addEventListener('click', closePreview);
setInterval(() => previewItem && syncPreviewUi(), 400);

/** Mantém a prévia coerente com a fila: fecha se o item saiu ou começou a tocar na TV; acompanha o tom. */
function reconcilePreview() {
  if (!previewItem) return;
  const item = state.queue.find((i) => i.id === previewItem.id);
  if (!item || item.id === state.current_item_id) return closePreview();
  previewItem.can_edit = item.can_edit;
  previewItem.key = item.song.key;
  if (item.can_edit && item.pitch !== previewPitch) {
    previewPitch = item.pitch; // o tom foi mudado por outro controle (ex.: o botão do item)
    preview.setPitch(previewPitch);
  }
  syncPreviewUi();
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

function nextSingerLine() {
  const next = nextUp(state);
  if (!next) return null;
  return h('p', { class: 'next-singer' },
    'Próximo: ',
    h('strong', {}, next.item.added_by),
    h('span', { class: 'muted' }, ` — ${next.item.title ?? next.item.video_id}${next.preparing ? ' (preparando…)' : ''}`));
}

function renderNow(current) {
  els.nowBody.textContent = '';
  nowRefs = null;
  if (!current) {
    const next = nextSingerLine();
    els.nowBody.append(h('div', { class: 'now-content' },
      h('p', { class: 'hint' }, state.queue.length
        ? 'Preparando a próxima música… ela começa sozinha quando estiver pronta.'
        : 'Nada tocando. Toque em Adicionar para escolher uma música.'),
      next));
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
        h('span', { class: 'now-singer' }, icon('singing'), ` ${current.added_by} está cantando`),
        current.song.key ? h('span', { class: 'muted small' }, keySummary(current.song.key, current.pitch)) : null,
        h('span', { class: 'muted small' }, `Letra: ${describeLyricsSource(current.song.lyrics_source)}`))),
    h('div', { class: 'progress' }, h('div', { class: 'track' }, bar), time),
    nextSingerLine(),
    h('div', { class: 'controls-row' },
      isHost() ? [
        h('button', { type: 'button', onclick: () => act('POST', `/player/${state.playback === 'paused' ? 'resume' : 'pause'}`).catch(() => {}) },
          state.playback === 'paused' ? 'Retomar' : 'Pausar'),
        h('button', { type: 'button', 'aria-label': 'Voltar 10 segundos', onclick: () => act('POST', '/player/seek', { seconds: -10 }).catch(() => {}) }, '⏪ 10s'),
        h('button', { type: 'button', 'aria-label': 'Avançar 10 segundos', onclick: () => act('POST', '/player/seek', { seconds: 10 }).catch(() => {}) }, '10s ⏩'),
        h('button', { type: 'button', onclick: () => act('POST', '/player/skip').catch(() => {}) }, 'Pular'),
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
    !state.tv_connected ? h('p', { class: 'hint error' }, 'A TV não está conectada: abra o menu (⋯) e toque em “Abrir TV” para a música tocar.') : null,
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
    h('span', { class: 'muted' }, item.artist ? `${item.artist} · ` : null, icon('singing'), ` ${item.added_by}`),
    item.song.key ? h('span', { class: 'muted small' }, keySummary(item.song.key, item.pitch)) : null,
    h('span', { class: 'chips' },
      h('span', { class: `chip ${chip.kind}` }, chip.label),
      item.id === state.next_item_id ? h('span', { class: 'chip is-next' }, 'Próximo') : null),
    item.song.status === 'needs_lyrics' || item.song.status === 'failed' || (item.song.stage === 'retrying' && item.song.error)
      ? h('span', { class: 'muted small' }, item.song.error ?? '') : null);

  const actions = h('div', { class: 'actions' },
    item.song.ready
      ? h('button', { type: 'button', class: 'ghost', onclick: () => openPreview(item) }, 'Prévia') : null,
    item.song.status === 'needs_lyrics' && item.can_edit
      ? h('button', { type: 'button', onclick: () => panel.chooseLyrics(item.video_id, item.song.error, { artist: item.artist, title: item.title }) }, 'Escolher letra') : null,
    canRetry(item.song) && item.can_edit
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
      h('button', { type: 'button', 'aria-label': 'Subir na fila', disabled: state.fair || index === 0, title: state.fair ? 'Com o rodízio justo ligado a ordem é automática' : null, onclick: () => act('POST', `/queue/${item.id}/move`, { direction: 'up' }).catch(() => {}) }, '▲'),
      h('button', { type: 'button', 'aria-label': 'Descer na fila', disabled: state.fair || index === waiting.length - 1, title: state.fair ? 'Com o rodízio justo ligado a ordem é automática' : null, onclick: () => act('POST', `/queue/${item.id}/move`, { direction: 'down' }).catch(() => {}) }, '▼'),
    ] : item.mine
      // quem não é anfitrião pode adiar a PRÓPRIA música em uma posição (foi ao banheiro, quer esperar mais um pouco)
      ? h('button', {
        type: 'button',
        class: 'ghost',
        title: 'Passa a sua música uma posição para trás: a pessoa de trás canta antes',
        disabled: state.fair || index === waiting.length - 1,
        onclick: () => act('POST', `/queue/${item.id}/move`, { direction: 'down' })
          .then(() => toast('Você cedeu a vez: sua música desceu uma posição.')).catch(() => {}),
      }, 'Ceder a vez') : null,
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
  const { current, upcoming: waiting } = playOrder(state);

  if (!connected) els.tvStatus.textContent = 'Reconectando à sala…';
  else els.tvStatus.replaceChildren(icon('display'), state.tv_connected ? ' TV conectada' : ' TV desconectada');
  els.tvStatus.classList.toggle('on', connected && state.tv_connected);
  els.copyHost.hidden = !isHost();
  els.hostSettings.hidden = !isHost();
  els.fair.checked = state.fair;
  els.hostScoring.hidden = !isHost();
  els.scoring.checked = state.scoring;
  els.scoreboardCard.hidden = !state.scoring && !state.scoreboard?.length;
  els.scoreboard.replaceChildren(...(state.scoreboard ?? []).map((row) =>
    h('li', {}, h('strong', {}, row.name), h('span', { class: 'muted' }, ` ${row.title ?? ''}`), h('b', { class: 'points' }, String(row.score)))));

  renderNow(current);

  els.queue.textContent = '';
  waiting.forEach((item, i) => els.queue.append(queueItem(item, i, waiting)));
  els.queueCount.textContent = waiting.length ? `(${waiting.length})` : '';
  els.tabCount.textContent = state.queue.length ? `(${state.queue.length})` : '';
  els.queueEmpty.hidden = waiting.length > 0;
  reconcilePreview();
}

// --- biblioteca (músicas já processadas), com filtro por artista e nome ---
let librarySongs = [];

/** Gera o MP4 da música no tom escolhido e baixa quando estiver pronto (o worker leva alguns segundos). */
async function exportSong(song, pitch, button) {
  const label = button.textContent;
  button.disabled = true;
  try {
    toast('Gerando o vídeo… pode levar alguns segundos.');
    const url = await requestExport(api, song.video_id, pitch, { onWaiting: () => { button.textContent = 'Gerando…'; } });
    downloadFile(url, exportFileName(song, pitch));
    toast('Vídeo pronto! O download começou.');
  } catch (err) {
    toast(err.message, true);
  } finally {
    button.textContent = label;
    button.disabled = false;
  }
}

function librarySong(song) {
  const pitchSelect = h('select', { 'aria-label': 'Tom do vídeo MP4', class: 'export-pitch' },
    EXPORT_PITCHES.map((value) => h('option', { value: String(value), selected: value === 0 }, formatPitch(value))));
  const exportButton = h('button', {
    type: 'button',
    class: 'ghost',
    title: 'Baixa um vídeo MP4 com o instrumental e a letra, para cantar offline',
    onclick: () => exportSong(song, Number(pitchSelect.value), exportButton),
  }, 'Baixar MP4');
  return h('li', {},
    h('img', { src: thumbnailUrl(song.video_id), alt: '', class: 'thumb', loading: 'lazy' }),
    h('div', { class: 'info' },
      h('strong', {}, song.title ?? song.video_id),
      h('span', { class: 'muted' }, [song.artist, song.duration ? formatDuration(song.duration) : null].filter(Boolean).join(' · ')),
      song.key ? h('span', { class: 'muted small' }, keySummary(song.key)) : null,
      h('span', { class: 'export-row' }, exportButton, h('label', { class: 'muted small' }, 'tom ', pitchSelect))),
    h('button', {
      type: 'button',
      class: 'primary',
      onclick: async () => {
        try {
          await act('POST', '/queue', { video_id: song.video_id, name: myName(), display_title: song.title ?? undefined });
          toast('Adicionada à fila!');
        } catch {
          // o erro já apareceu no aviso
        }
      },
    }, 'Adicionar'));
}

/** Desenha a lista aplicando o filtro digitado (o filtro sobrevive às atualizações da lista). */
function renderLibrary() {
  const all = sortSongs(librarySongs);
  const query = els.libraryFilter.value.trim();
  const shown = filterSongs(all, query);
  els.libraryList.textContent = '';
  for (const song of shown) els.libraryList.append(librarySong(song));
  els.libraryCount.textContent = !all.length ? '' : query ? `(${shown.length} de ${all.length})` : `(${all.length})`;
  els.libraryEmpty.hidden = shown.length > 0;
  els.libraryEmptyText.textContent = !all.length ? 'Nenhuma música processada ainda.' : `Nenhuma música encontrada para “${query}”.`;
  els.libraryClear.hidden = !(query && !shown.length);
}

async function loadLibrary() {
  try {
    librarySongs = await api('GET', '/api/songs');
  } catch {
    return;
  }
  renderLibrary();
}

els.libraryFilter.addEventListener('input', renderLibrary);
els.libraryClear.addEventListener('click', () => {
  els.libraryFilter.value = '';
  renderLibrary();
  els.libraryFilter.focus();
});

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
  onShow: () => showTab('add'),
  async submitNew(body) {
    const result = await act('POST', '/queue', { ...body, name: myName() });
    loadLibrary();
    showTab('queue');
    if (result.cached) return 'Adicionada à fila (essa música já estava pronta).';
    if (result.deduped) return 'Adicionada à fila (essa música já estava sendo preparada).';
    return 'Adicionada à fila! Ela está sendo preparada e toca quando chegar a vez.';
  },
  async submitLyrics(videoId, body) {
    await api('PUT', `/api/songs/${videoId}/lyrics`, body, code);
    showTab('queue');
    return 'Letra enviada. A música volta a ser preparada.';
  },
});

// --- menu e ações do anfitrião ---
els.openTv.addEventListener('click', () => {
  els.menu.open = false;
  window.open(`tv.html?room=${code}`, '_blank');
});
els.copyLink.addEventListener('click', () => {
  els.menu.open = false;
  copyText(`${location.origin}/room.html?room=${code}`, 'Link da sala copiado!');
});
els.copyHost.addEventListener('click', () => {
  els.menu.open = false;
  copyText(`${location.origin}/room.html?room=${code}#host=${hostToken(code)}`, 'Link de anfitrião copiado! Quem abrir controla a sala.');
});
els.scoring.addEventListener('change', () => act('PATCH', '', { scoring: els.scoring.checked }).catch(() => { els.scoring.checked = !els.scoring.checked; }));
els.fair.addEventListener('change', () => act('PATCH', '', { fair: els.fair.checked }).catch(() => { els.fair.checked = !els.fair.checked; }));

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
    document.querySelector('.tabbar').hidden = true;
  },
});

setInterval(updateProgress, 500);
loadLibrary();

// gancho de diagnóstico (testes no navegador)
window.room = {
  get state() { return state; },
  preview,
  get previewPitch() { return previewPitch; },
};
