// Painel "Adicionar música": pesquisa no YouTube ou link direto, escolha da letra, acompanhamento do job.
import { formatTime, looksLikeLink } from './lyrics-sync.js';

const $ = (id) => document.getElementById(id);
const els = {
  panel: $('add'),
  form: $('add-form'),
  url: $('add-url'),
  search: $('add-search'),
  results: $('add-results'),
  picked: $('add-picked'),
  source: $('add-source'),
  sourceHint: $('add-source-hint'),
  text: $('add-text'),
  names: $('add-names'),
  artist: $('add-artist'),
  title: $('add-title'),
  submit: $('add-submit'),
  cancel: $('add-cancel'),
  status: $('add-status'),
};

const STAGES = {
  pending: 'Na fila…',
  downloading: 'Baixando o áudio…',
  separating: 'Separando a voz da música (pode levar alguns minutos)…',
  lyrics: 'Buscando a letra…',
  aligning: 'Sincronizando a letra com a voz (IA)… pode levar um minuto.',
};

const SOURCE_HINTS = {
  auto: 'Se o vídeo não tiver legenda, eu aviso e você escolhe outra opção.',
  lrclib: 'Procura a letra na internet. Se achar uma versão com os tempos certos, usa; senão, a IA sincroniza a letra com a voz da música (leva cerca de 1 minuto). Informe o artista e o nome da música para achar melhor.',
  text: 'Cole a letra, uma linha por verso. Os tempos vêm da legenda do vídeo ou da busca na internet.',
  align: 'Cole a letra, uma linha por verso. A IA ouve a voz da música e descobre quando cada linha é cantada. Leva cerca de 1 minuto e funciona bem em covers.',
  none: 'Toca só o instrumental, sem letra na tela.',
  file: 'Cole o conteúdo de um arquivo .lrc ou .srt (letra com o tempo de cada linha).',
};

// opções em que o usuário cola um texto
const TEXT_SOURCES = ['text', 'file', 'align'];

let pollTimer = null;
let pendingLyricsId = null; // música aguardando a escolha da letra (needs_lyrics)

function setStatus(text, isError = false) {
  els.status.textContent = text;
  els.status.classList.toggle('error', isError);
}

function stopPolling() {
  clearTimeout(pollTimer);
  pollTimer = null;
}

function setMode(lyricsId) {
  pendingLyricsId = lyricsId;
  els.url.disabled = Boolean(lyricsId);
  els.search.disabled = Boolean(lyricsId);
  els.cancel.hidden = !lyricsId;
  els.submit.textContent = lyricsId ? 'Aplicar letra' : 'Adicionar';
  els.panel.open = true;
}

function syncSourceUi() {
  const source = els.source.value;
  const needsText = TEXT_SOURCES.includes(source);
  els.sourceHint.textContent = SOURCE_HINTS[source] ?? '';
  els.text.hidden = !needsText;
  els.text.required = needsText;
  // artista e nome ajudam a achar a letra na internet
  els.names.hidden = source !== 'lrclib';
}

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.message ?? data.error ?? `HTTP ${res.status}`);
  return data;
}

function lyricsPayload() {
  const source = els.source.value;
  return {
    source,
    ...(TEXT_SOURCES.includes(source) ? { text: els.text.value } : {}),
  };
}

function namesPayload() {
  const artist = els.artist.value.trim();
  const title = els.title.value.trim();
  return { ...(artist ? { artist } : {}), ...(title ? { title } : {}) };
}

// --- pesquisa de vídeos ---
function clearResults() {
  els.results.hidden = true;
  els.results.textContent = '';
}

function pick(result) {
  els.url.value = `https://www.youtube.com/watch?v=${result.video_id}`;
  els.picked.textContent = `Selecionado: ${result.title}${result.channel ? ` — ${result.channel}` : ''}`;
  els.picked.hidden = false;
  clearResults();
  setStatus('');
}

function renderResults(results) {
  els.results.textContent = '';
  for (const result of results) {
    const item = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'result';

    const img = document.createElement('img');
    img.src = result.thumbnail;
    img.alt = '';
    img.loading = 'lazy';

    const meta = document.createElement('span');
    meta.className = 'meta';
    const title = document.createElement('strong');
    title.textContent = result.title; // textContent: títulos vêm de terceiros
    const sub = document.createElement('small');
    sub.textContent = [result.channel, result.duration ? formatTime(result.duration) : null].filter(Boolean).join(' · ');
    meta.append(title, sub);

    button.append(img, meta);
    button.addEventListener('click', () => pick(result));
    item.append(button);
    els.results.append(item);
  }
  els.results.hidden = false;
}

async function runSearch() {
  const query = els.url.value.trim();
  if (query.length < 2) return setStatus('Digite pelo menos 2 letras para pesquisar.', true);
  els.picked.hidden = true;
  els.search.disabled = true;
  setStatus('Pesquisando no YouTube…');
  try {
    const results = await api('GET', `/api/search?q=${encodeURIComponent(query)}`);
    if (!results.length) {
      clearResults();
      return setStatus('Nada encontrado. Tente outras palavras ou cole o link do vídeo.', true);
    }
    renderResults(results);
    setStatus('Clique no vídeo que você quer.');
  } catch (err) {
    clearResults();
    setStatus(err.message, true);
  } finally {
    els.search.disabled = Boolean(pendingLyricsId);
  }
}

// --- acompanhamento do job ---
/** Acompanha o job; termina em ready, needs_lyrics ou failed. */
function follow(id) {
  stopPolling();
  const tick = async () => {
    let song;
    try {
      song = await api('GET', `/api/songs/${id}`);
    } catch (err) {
      setStatus(`Erro ao consultar a música: ${err.message}`, true);
      return;
    }
    if (song.status === 'ready') {
      // o player não interrompe uma música que está tocando: a nova só entra na lista
      const busy = window.singalong?.playing && window.singalong.currentSongId !== id;
      setStatus(busy ? 'Pronta! Adicionada à lista — escolha-a quando a música atual terminar.' : 'Pronta! Carregando no player…');
      setMode(null);
      els.form.reset();
      els.picked.hidden = true;
      syncSourceUi();
      document.dispatchEvent(new CustomEvent('songs-changed', { detail: { video_id: id } }));
      return;
    }
    if (song.status === 'needs_lyrics') {
      setMode(id);
      setStatus(`${song.error ?? 'Preciso que você escolha a letra.'} Escolha uma opção acima e clique em “Aplicar letra”.`, true);
      return;
    }
    if (song.status === 'failed') {
      setMode(null);
      setStatus(`Não deu certo: ${song.error ?? 'erro desconhecido'}. Você pode tentar de novo.`, true);
      return;
    }
    setStatus(STAGES[song.stage] ?? STAGES.pending);
    pollTimer = setTimeout(tick, 2000);
  };
  tick();
}

els.source.addEventListener('change', syncSourceUi);
els.search.addEventListener('click', runSearch);
els.url.addEventListener('input', () => {
  els.picked.hidden = true; // o texto mudou: a seleção anterior não vale mais
});

els.cancel.addEventListener('click', () => {
  stopPolling();
  setMode(null);
  setStatus('');
});

els.form.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!pendingLyricsId && !looksLikeLink(els.url.value)) return runSearch(); // Enter num nome = pesquisar
  els.submit.disabled = true;
  try {
    let song;
    if (pendingLyricsId) {
      song = await api('PUT', `/api/songs/${pendingLyricsId}/lyrics`, { ...lyricsPayload(), ...namesPayload() });
    } else {
      song = await api('POST', '/api/songs', { url: els.url.value.trim(), lyrics: lyricsPayload(), ...namesPayload() });
      if (song.cached) setStatus('Essa música já estava pronta.');
      else if (song.deduped) setStatus('Essa música já está sendo processada.');
    }
    clearResults();
    follow(song.video_id);
  } catch (err) {
    setStatus(err.message, true);
  } finally {
    els.submit.disabled = false;
  }
});

syncSourceUi();
