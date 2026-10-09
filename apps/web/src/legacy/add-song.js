// Painel "Adicionar música". A pessoa informa Artista e Nome da música (obrigatórios): eles pesquisam o vídeo no YouTube
// ("Artista - Nome") e depois buscam a letra. O link do vídeo é uma alternativa para quem já o tem.
// Não sabe nada de salas: quem usa passa as funções que enviam o pedido (submitNew) e que trocam a letra de um item
// que a pede (submitLyrics).
import { api } from '../lib/identity.js';
import { formatDuration, thumbnailUrl } from '../lib/queue-view.js';
import { buildSearchQuery, embedUrl, extractVideoId, watchUrl } from '../lib/youtube.js';

const SOURCE_HINTS = {
  lrclib: 'Procura a letra com o artista e o nome da música que você informou. Se achar uma versão com os tempos certos, usa; senão, a IA sincroniza a letra com a voz da música (cerca de 1 minuto).',
  auto: 'Usa a legenda do vídeo, se ele tiver uma. Se não tiver, a música entra na fila e eu aviso para você escolher outra opção.',
  align: 'Cole a letra, uma linha por verso. A IA ouve a voz da música e descobre quando cada linha é cantada. Leva cerca de 1 minuto e funciona bem em covers.',
  none: 'Toca só o instrumental, sem letra na tela.',
  file: 'Cole o conteúdo de um arquivo .lrc ou .srt (letra com o tempo de cada linha).',
};

// opções em que a pessoa cola um texto
const TEXT_SOURCES = ['file', 'align'];

/**
 * @param submitNew     async ({url, lyrics, artist, title, display_title}) => mensagem de sucesso
 * @param submitLyrics  async (videoId, {source, text?, artist?, title?}) => mensagem de sucesso
 * @param onShow        () => void   chamado quando o painel precisa aparecer (ex.: abrir a aba "Adicionar")
 * @returns { chooseLyrics(videoId, reason, {artist, title}) }  abre o painel para escolher a letra de um item da fila
 */
export function initAddPanel({ submitNew, submitLyrics, onShow }) {
  const $ = (id) => document.getElementById(id);
  const els = {
    form: $('add-form'),
    artist: $('add-artist'),
    title: $('add-title'),
    search: $('add-search'),
    results: $('add-results'),
    pickedBox: $('add-picked-box'),
    picked: $('add-picked'),
    previewBtn: $('add-preview-btn'),
    preview: $('add-preview'),
    linkBox: $('add-link-box'),
    url: $('add-url'),
    source: $('add-source'),
    sourceHint: $('add-source-hint'),
    text: $('add-text'),
    submit: $('add-submit'),
    cancel: $('add-cancel'),
    status: $('add-status'),
  };

  let lyricsFor = null; // vídeo que espera a escolha da letra (item da fila em needs_lyrics)
  let selectedId = null; // vídeo escolhido na pesquisa (ou colado como link)
  let selectedLabel = null; // título do vídeo escolhido na pesquisa
  let previewing = null; // id do vídeo cuja prévia está aberta

  function setStatus(text, isError = false) {
    els.status.textContent = text;
    els.status.classList.toggle('error', isError);
  }

  // --- prévia do vídeo (player oficial do YouTube): para conferir se é a música certa antes de adicionar ---
  function closePreview() {
    previewing = null;
    els.preview.hidden = true;
    els.preview.textContent = '';
    els.previewBtn.textContent = 'Ouvir no YouTube';
    document.querySelectorAll('.result-row .preview-toggle').forEach((b) => { b.textContent = 'Prévia'; });
    document.querySelectorAll('.result-row .inline-preview').forEach((el) => el.remove());
  }

  function previewNode(videoId) {
    const frame = document.createElement('iframe');
    frame.src = embedUrl(videoId);
    frame.title = 'Prévia do vídeo';
    frame.allow = 'autoplay; encrypted-media; picture-in-picture';
    frame.allowFullscreen = true;
    frame.referrerPolicy = 'strict-origin-when-cross-origin';
    const link = document.createElement('a');
    link.href = watchUrl(videoId);
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = 'Não carregou? Abrir no YouTube';
    const wrap = document.createElement('div');
    wrap.className = 'video-frame';
    wrap.append(frame, link);
    return wrap;
  }

  function togglePreviewOfSelection() {
    if (!selectedId) return;
    const wasOpen = previewing === selectedId && !els.preview.hidden;
    closePreview();
    if (wasOpen) return;
    previewing = selectedId;
    els.previewBtn.textContent = 'Fechar prévia';
    els.preview.hidden = false;
    els.preview.append(previewNode(selectedId));
  }

  /** Mostra o vídeo selecionado (escolhido na pesquisa ou colado como link) com o botão de prévia. */
  function syncSelection() {
    els.pickedBox.hidden = !selectedId;
    if (selectedId) els.picked.textContent = selectedLabel ? `Selecionado: ${selectedLabel}` : `Link reconhecido: ${selectedId}`;
  }

  function select(videoId, label = null) {
    selectedId = videoId;
    selectedLabel = label;
    els.url.value = videoId ? watchUrl(videoId) : '';
    syncSelection();
  }

  // --- campos ---
  function setLyricsMode(videoId) {
    lyricsFor = videoId;
    els.search.disabled = Boolean(videoId);
    els.url.disabled = Boolean(videoId);
    els.cancel.hidden = !videoId;
    els.submit.textContent = videoId ? 'Aplicar letra' : 'Adicionar à fila';
    syncRequired();
    onShow?.();
  }

  /** Artista e nome são obrigatórios; só não precisam de novo ao trocar a letra de um item já na fila (a menos que a busca online precise). */
  function syncRequired() {
    const required = !lyricsFor || els.source.value === 'lrclib';
    els.artist.required = required;
    els.title.required = required;
  }

  function syncSourceUi() {
    const source = els.source.value;
    const needsText = TEXT_SOURCES.includes(source);
    els.sourceHint.textContent = SOURCE_HINTS[source] ?? '';
    els.text.hidden = !needsText;
    els.text.required = needsText;
    syncRequired();
  }

  function lyricsPayload() {
    const source = els.source.value;
    return { source, ...(TEXT_SOURCES.includes(source) ? { text: els.text.value } : {}) };
  }

  const names = () => ({ artist: els.artist.value.replace(/\s+/g, ' ').trim(), title: els.title.value.replace(/\s+/g, ' ').trim() });

  function reset() {
    const name = $('user-name').value; // o nome da pessoa fica
    els.form.reset();
    $('user-name').value = name;
    els.linkBox.open = false;
    select(null);
    closePreview();
    syncSourceUi();
  }

  // --- pesquisa de vídeos: "Artista - Nome da música" ---
  function clearResults() {
    closePreview();
    els.results.hidden = true;
    els.results.textContent = '';
  }

  function renderResults(results) {
    els.results.textContent = '';
    for (const result of results) {
      const item = document.createElement('li');
      const row = document.createElement('div');
      row.className = 'result-row';

      const choose = document.createElement('button');
      choose.type = 'button';
      choose.className = 'result';
      const img = document.createElement('img');
      img.src = result.thumbnail ?? thumbnailUrl(result.video_id);
      img.alt = '';
      img.loading = 'lazy';
      const meta = document.createElement('span');
      meta.className = 'meta';
      const title = document.createElement('strong');
      title.textContent = result.title; // textContent: títulos vêm de terceiros
      const sub = document.createElement('small');
      sub.textContent = [result.channel, result.duration ? formatDuration(result.duration) : null].filter(Boolean).join(' · ');
      meta.append(title, sub);
      choose.append(img, meta);
      choose.addEventListener('click', () => {
        select(result.video_id, result.title);
        clearResults();
        setStatus('');
      });

      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'preview-toggle';
      toggle.textContent = 'Prévia';
      toggle.setAttribute('aria-label', `Ouvir uma prévia de ${result.title}`);
      const inline = document.createElement('div');
      inline.className = 'inline-preview';
      toggle.addEventListener('click', () => {
        const wasOpen = previewing === result.video_id;
        closePreview();
        if (wasOpen) return;
        previewing = result.video_id;
        toggle.textContent = 'Fechar';
        inline.append(previewNode(result.video_id));
        row.after(inline);
      });

      row.append(choose, toggle);
      item.append(row);
      els.results.append(item);
    }
    els.results.hidden = false;
  }

  async function runSearch() {
    const query = buildSearchQuery(els.artist.value, els.title.value);
    if (!query) {
      setStatus('Informe o artista e o nome da música para buscar o vídeo.', true);
      (els.artist.value.trim() ? els.title : els.artist).focus();
      return;
    }
    select(null);
    els.search.disabled = true;
    setStatus(`Buscando “${query}” no YouTube…`);
    try {
      const results = await api('GET', `/api/search?q=${encodeURIComponent(query)}`);
      if (!results.length) {
        clearResults();
        return setStatus('Nada encontrado. Confira o artista e o nome, ou use “Já tenho o link do vídeo”.', true);
      }
      renderResults(results);
      setStatus('Toque no vídeo certo. Use “Prévia” para ouvir antes de escolher.');
    } catch (err) {
      clearResults();
      setStatus(err.message, true);
    } finally {
      els.search.disabled = Boolean(lyricsFor);
    }
  }

  els.source.addEventListener('change', syncSourceUi);
  els.search.addEventListener('click', runSearch);
  els.previewBtn.addEventListener('click', togglePreviewOfSelection);
  els.url.addEventListener('input', () => {
    // link colado à mão: vale como seleção (se não for um link do YouTube, não há seleção)
    const id = extractVideoId(els.url.value);
    selectedId = id;
    selectedLabel = null;
    if (previewing && previewing !== id) closePreview();
    syncSelection();
  });
  els.cancel.addEventListener('click', () => {
    setLyricsMode(null);
    setStatus('');
  });

  els.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    // Enter nos campos de artista/nome, sem vídeo escolhido ainda: busca o vídeo
    if (!lyricsFor && !selectedId) return runSearch();
    els.submit.disabled = true;
    try {
      let message;
      if (lyricsFor) {
        message = await submitLyrics(lyricsFor, { ...lyricsPayload(), ...Object.fromEntries(Object.entries(names()).filter(([, v]) => v)) });
        setLyricsMode(null);
      } else {
        const { artist, title } = names();
        message = await submitNew({
          url: watchUrl(selectedId),
          lyrics: lyricsPayload(),
          artist,
          title,
          display_title: title, // na fila aparece o nome que a pessoa informou, não o título (às vezes bagunçado) do vídeo
        });
      }
      clearResults();
      reset();
      setStatus(message ?? 'Pronto!');
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      els.submit.disabled = false;
    }
  });

  syncSourceUi();
  syncSelection();

  return {
    /** Abre o painel já no modo "escolher a letra" de um item da fila que não achou letra. */
    chooseLyrics(videoId, reason, { artist, title } = {}) {
      if (artist) els.artist.value = artist;
      if (title) els.title.value = title;
      setLyricsMode(videoId);
      setStatus(`${reason ?? 'Preciso que você escolha a letra.'} Escolha uma opção acima e toque em “Aplicar letra”.`, true);
    },
  };
}
