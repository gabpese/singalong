// Painel "Adicionar música": pesquisa no YouTube ou link, escolha da letra e envio. Não sabe nada de salas:
// quem usa passa as funções que enviam o pedido (submitNew) e que trocam a letra de um item que a pede (submitLyrics).
import { api } from './identity.js';
import { formatDuration, thumbnailUrl } from './queue-view.js';
import { looksLikeLink } from './lyrics-sync.js';

const SOURCE_HINTS = {
  auto: 'Se o vídeo não tiver legenda, a música entra na fila e eu aviso para você escolher outra opção.',
  lrclib: 'Procura a letra na internet. Se achar uma versão com os tempos certos, usa; senão, a IA sincroniza a letra com a voz da música (cerca de 1 minuto). Informe o artista e o nome da música para achar melhor.',
  align: 'Cole a letra, uma linha por verso. A IA ouve a voz da música e descobre quando cada linha é cantada. Leva cerca de 1 minuto e funciona bem em covers.',
  none: 'Toca só o instrumental, sem letra na tela.',
  file: 'Cole o conteúdo de um arquivo .lrc ou .srt (letra com o tempo de cada linha).',
};

// opções em que a pessoa cola um texto
const TEXT_SOURCES = ['file', 'align'];

/**
 * @param submitNew     async ({url, lyrics, artist?, title?, display_title?}) => mensagem de sucesso
 * @param submitLyrics  async (videoId, {source, text?, artist?, title?}) => mensagem de sucesso
 * @returns { chooseLyrics(videoId, reason) }  abre o painel para escolher a letra de um item da fila
 */
export function initAddPanel({ submitNew, submitLyrics }) {
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

  let lyricsFor = null; // vídeo que espera a escolha da letra (item da fila em needs_lyrics)
  let pickedTitle = null; // título escolhido na pesquisa (aparece na fila até a música ficar pronta)

  function setStatus(text, isError = false) {
    els.status.textContent = text;
    els.status.classList.toggle('error', isError);
  }

  function setLyricsMode(videoId) {
    lyricsFor = videoId;
    els.url.disabled = Boolean(videoId);
    els.search.disabled = Boolean(videoId);
    els.cancel.hidden = !videoId;
    els.submit.textContent = videoId ? 'Aplicar letra' : 'Adicionar à fila';
    els.panel.open = true;
  }

  function syncSourceUi() {
    const source = els.source.value;
    const needsText = TEXT_SOURCES.includes(source);
    els.sourceHint.textContent = SOURCE_HINTS[source] ?? '';
    els.text.hidden = !needsText;
    els.text.required = needsText;
    els.names.hidden = source !== 'lrclib'; // artista e nome ajudam a achar a letra na internet
  }

  function lyricsPayload() {
    const source = els.source.value;
    return { source, ...(TEXT_SOURCES.includes(source) ? { text: els.text.value } : {}) };
  }

  function namesPayload() {
    const artist = els.artist.value.trim();
    const title = els.title.value.trim();
    return { ...(artist ? { artist } : {}), ...(title ? { title } : {}) };
  }

  function reset() {
    els.form.reset();
    els.picked.hidden = true;
    pickedTitle = null;
    syncSourceUi();
  }

  // --- pesquisa de vídeos ---
  function clearResults() {
    els.results.hidden = true;
    els.results.textContent = '';
  }

  function pick(result) {
    els.url.value = `https://www.youtube.com/watch?v=${result.video_id}`;
    pickedTitle = result.title;
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
      els.search.disabled = Boolean(lyricsFor);
    }
  }

  els.source.addEventListener('change', syncSourceUi);
  els.search.addEventListener('click', runSearch);
  els.url.addEventListener('input', () => {
    els.picked.hidden = true; // o texto mudou: a seleção anterior não vale mais
    pickedTitle = null;
  });
  els.cancel.addEventListener('click', () => {
    setLyricsMode(null);
    setStatus('');
  });

  els.form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!lyricsFor && !looksLikeLink(els.url.value)) return runSearch(); // Enter num nome = pesquisar
    els.submit.disabled = true;
    try {
      let message;
      if (lyricsFor) {
        message = await submitLyrics(lyricsFor, { ...lyricsPayload(), ...namesPayload() });
        setLyricsMode(null);
      } else {
        message = await submitNew({
          url: els.url.value.trim(),
          lyrics: lyricsPayload(),
          ...namesPayload(),
          ...(pickedTitle ? { display_title: pickedTitle } : {}),
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

  return {
    /** Abre o painel já no modo "escolher a letra" de um item da fila que não achou letra. */
    chooseLyrics(videoId, reason) {
      setLyricsMode(videoId);
      setStatus(`${reason ?? 'Preciso que você escolha a letra.'} Escolha uma opção acima e clique em “Aplicar letra”.`, true);
      els.panel.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    },
  };
}
