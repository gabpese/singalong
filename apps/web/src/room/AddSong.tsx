// Painel "Adicionar música". A pessoa procura o vídeo como no YouTube: pelo artista, pelo nome da música ou pelos dois
// (basta um). Antes de ir ao YouTube, confere se a música já está pronta no Jukebox. Depois de escolher o vídeo, confirma
// o artista e o nome da música (os dois são obrigatórios: alimentam a busca da letra e o que aparece na fila).
// O link do vídeo é uma alternativa para quem já o tem.
// Não sabe nada de salas: quem usa passa as funções que enviam o pedido (submitNew) e que trocam a letra de um item
// que a pede (submitLyrics).
import { forwardRef, type FormEvent, useImperativeHandle, useRef, useState } from 'react';
import { api } from '../lib/identity.js';
import { findJukeboxMatches, formatDuration, thumbnailUrl } from '../lib/queue-view.js';
import { buildSearchQuery, embedUrl, extractVideoId, guessArtistTitle, watchUrl } from '../lib/youtube.js';
import type { ApiError, LibrarySong } from '../lib/types';
import { Icon } from '../ui/Icon';
import { JukeboxDialog } from './JukeboxDialog';

const SOURCE_HINTS: Record<string, string> = {
  lrclib:
    'Procura a letra com o artista e o nome da música que você confirmou. Se achar uma versão com os tempos certos, usa; senão, a IA sincroniza a letra com a voz da música (cerca de 1 minuto).',
  auto: 'Usa a legenda do vídeo, se ele tiver uma. Se não tiver, a música entra na fila e eu aviso para você escolher outra opção.',
  align:
    'Cole a letra, uma linha por verso. A IA ouve a voz da música e descobre quando cada linha é cantada. Leva cerca de 1 minuto e funciona bem em covers.',
  none: 'Toca só o instrumental, sem letra na tela.',
  file: 'Cole o conteúdo de um arquivo .lrc ou .srt (letra com o tempo de cada linha).',
};

// opções em que a pessoa cola um texto
const TEXT_SOURCES = ['file', 'align'];

interface SearchResult {
  video_id: string;
  title: string;
  channel?: string | null;
  duration?: number | null;
  thumbnail?: string | null;
}

interface NewSong {
  url: string;
  lyrics: { source: string; text?: string };
  artist: string;
  title: string;
  display_title: string;
}

export interface AddSongHandle {
  /** Abre o painel já no modo "escolher a letra" de um item da fila que não achou letra. */
  chooseLyrics(videoId: string, reason: string | null, names?: { artist?: string | null; title?: string | null }): void;
}

interface Props {
  userName: string;
  onUserName: (name: string) => void;
  /** Envia o pedido e devolve a mensagem de sucesso. */
  submitNew: (song: NewSong) => Promise<string>;
  submitLyrics: (videoId: string, body: Record<string, unknown>) => Promise<string>;
  /** O painel precisa aparecer (ex.: abrir a aba "Adicionar"). */
  onShow: () => void;
  /** Músicas já prontas (o Jukebox): se o que foi digitado bate com alguma, a pessoa pode usá-la em vez de buscar no YouTube. */
  jukebox: LibrarySong[];
  /** Coloca uma música pronta do Jukebox na fila e devolve a mensagem de sucesso. */
  onPickJukebox: (song: LibrarySong) => Promise<string>;
}

/** Player oficial do YouTube numa moldura: para conferir se é a música certa antes de adicionar. */
function VideoFrame({ videoId }: { videoId: string }) {
  return (
    <div className="video-frame">
      <iframe
        src={embedUrl(videoId)}
        title="Prévia do vídeo"
        allow="autoplay; encrypted-media; picture-in-picture"
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
      />
      <a href={watchUrl(videoId)} target="_blank" rel="noopener">
        Não carregou? Abrir no YouTube
      </a>
    </div>
  );
}

type Preview = { id: string; where: 'selection' | 'result' } | null;

export const AddSong = forwardRef<AddSongHandle, Props>(function AddSong(
  { userName, onUserName, submitNew, submitLyrics, onShow, jukebox, onPickJukebox },
  ref,
) {
  // o que a pessoa digita para PROCURAR (basta um dos dois)
  const [artist, setArtist] = useState('');
  const [title, setTitle] = useState('');
  // o que ela CONFIRMA depois de escolher o vídeo (os dois são obrigatórios)
  const [confirmArtist, setConfirmArtist] = useState('');
  const [confirmTitle, setConfirmTitle] = useState('');
  const [url, setUrl] = useState('');
  const [source, setSource] = useState('lrclib');
  const [text, setText] = useState('');
  const [linkOpen, setLinkOpen] = useState(false);
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [status, setStatusState] = useState({ text: '', isError: false });
  const [selected, setSelected] = useState<{ id: string; label: string | null } | null>(null); // vídeo escolhido (ou colado como link)
  const [preview, setPreview] = useState<Preview>(null); // prévia do YouTube aberta (só uma por vez)
  const [lyricsFor, setLyricsFor] = useState<string | null>(null); // vídeo que espera a escolha da letra (item em needs_lyrics)
  const [searching, setSearching] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [matches, setMatches] = useState<LibrarySong[] | null>(null); // versões prontas encontradas (abre o aviso)
  const [declinedFor, setDeclinedFor] = useState(''); // busca em que a pessoa preferiu o YouTube ao Jukebox
  const artistRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  const setStatus = (message: string, isError = false) => setStatusState({ text: message, isError });
  const needsText = TEXT_SOURCES.includes(source);
  // Confirmar artista e nome é obrigatório; só não precisa ao trocar a letra de um item já na fila (a menos que a busca online precise)
  const confirmRequired = !lyricsFor || source === 'lrclib';
  const showConfirm = Boolean(selected) || Boolean(lyricsFor);
  const names = () => ({ artist: confirmArtist.replace(/\s+/g, ' ').trim(), title: confirmTitle.replace(/\s+/g, ' ').trim() });
  const lyricsPayload = () => ({ source, ...(needsText ? { text } : {}) });

  function select(videoId: string | null, label: string | null = null) {
    setSelected(videoId ? { id: videoId, label } : null);
    setUrl(videoId ? watchUrl(videoId) : '');
  }

  /** Pré-preenche a confirmação: o que a pessoa digitou na busca vale mais; o que faltar vem de um palpite do título do vídeo. */
  function fillConfirm(videoTitle: string | null) {
    const guess: { artist: string; title: string } = guessArtistTitle(videoTitle);
    setConfirmArtist(artist.trim() || guess.artist);
    setConfirmTitle(title.trim() || guess.title);
  }

  function clearResults() {
    setPreview(null);
    setResults(null);
  }

  function reset() {
    // o nome da pessoa fica (ele não é um campo deste formulário)
    setArtist('');
    setTitle('');
    setConfirmArtist('');
    setConfirmTitle('');
    setUrl('');
    setSource('lrclib');
    setText('');
    setLinkOpen(false);
    setSelected(null);
    setPreview(null);
    setDeclinedFor('');
  }

  function togglePreviewOfSelection() {
    if (!selected) return;
    const wasOpen = preview?.id === selected.id && preview.where === 'selection';
    setPreview(wasOpen ? null : { id: selected.id, where: 'selection' });
  }

  async function runSearch({ skipJukebox = false } = {}) {
    const query: string | null = buildSearchQuery(artist, title);
    if (!query) {
      setStatus('Informe o artista ou o nome da música para buscar o vídeo.', true);
      (artist.trim() ? titleRef : artistRef).current?.focus();
      return;
    }
    // antes de ir ao YouTube: já temos essa música pronta? (não vale ao trocar a letra de um item que já está na fila)
    if (!skipJukebox && !lyricsFor && declinedFor !== query) {
      const found: LibrarySong[] = findJukeboxMatches(jukebox, artist, title);
      if (found.length) {
        clearResults();
        setStatus('');
        setMatches(found);
        return;
      }
    }
    select(null);
    setSearching(true);
    setStatus(`Buscando “${query}” no YouTube…`);
    try {
      const found: SearchResult[] = await api('GET', `/api/search?q=${encodeURIComponent(query)}`);
      if (!found.length) {
        clearResults();
        return setStatus('Nada encontrado. Confira o que você digitou, ou use “Já tenho o link do vídeo”.', true);
      }
      setPreview(null);
      setResults(found);
      setStatus('Toque no vídeo certo. Use “Prévia” para ouvir antes de escolher.');
    } catch (err) {
      clearResults();
      setStatus((err as ApiError).message, true);
    } finally {
      setSearching(false);
    }
  }

  function onUrlChange(value: string) {
    // link colado à mão: vale como seleção (se não for um link do YouTube, não há seleção)
    setUrl(value);
    const id: string | null = extractVideoId(value);
    if (id && !selected) fillConfirm(null); // sem título do vídeo para adivinhar: usa o que foi digitado na busca
    setSelected(id ? { id, label: null } : null);
    if (preview && preview.id !== id) setPreview(null);
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    // Enter nos campos de busca, sem vídeo escolhido ainda: busca o vídeo
    if (!lyricsFor && !selected) return runSearch();
    setSubmitting(true);
    try {
      let message: string;
      if (lyricsFor) {
        const filled = Object.fromEntries(Object.entries(names()).filter(([, value]) => value));
        message = await submitLyrics(lyricsFor, { ...lyricsPayload(), ...filled });
        setLyricsFor(null);
      } else {
        const { artist: cleanArtist, title: cleanTitle } = names();
        message = await submitNew({
          url: watchUrl(selected!.id),
          lyrics: lyricsPayload(),
          artist: cleanArtist,
          title: cleanTitle,
          display_title: cleanTitle, // na fila aparece o nome que a pessoa confirmou, não o título (às vezes bagunçado) do vídeo
        });
      }
      clearResults();
      reset();
      setStatus(message ?? 'Pronto!');
    } catch (err) {
      setStatus((err as ApiError).message, true);
    } finally {
      setSubmitting(false);
    }
  }

  async function useJukeboxSong(song: LibrarySong) {
    setSubmitting(true);
    try {
      const message = await onPickJukebox(song);
      setMatches(null);
      clearResults();
      reset();
      setStatus(message);
    } catch (err) {
      setMatches(null);
      setStatus((err as ApiError).message, true);
    } finally {
      setSubmitting(false);
    }
  }

  /** "Buscar outra versão no YouTube": segue a busca e não pergunta de novo para esta mesma busca. */
  function searchYoutubeAnyway() {
    setDeclinedFor(buildSearchQuery(artist, title) ?? '');
    setMatches(null);
    void runSearch({ skipJukebox: true });
  }

  useImperativeHandle(ref, () => ({
    chooseLyrics(videoId, reason, found = {}) {
      setConfirmArtist(found.artist ?? '');
      setConfirmTitle(found.title ?? '');
      setLyricsFor(videoId);
      onShow();
      setStatus(`${reason ?? 'Preciso que você escolha a letra.'} Escolha uma opção abaixo e toque em “Aplicar letra”.`, true);
    },
  }));

  const selectionPreview = preview?.where === 'selection' ? preview : null;

  return (
    <article className="card add">
      <h2>Adicionar música</h2>
      <form autoComplete="off" onSubmit={onSubmit}>
        <label className="field">
          Seu nome
          <input
            type="text"
            maxLength={30}
            placeholder="Como você quer aparecer na fila?"
            autoComplete="nickname"
            value={userName}
            onChange={(event) => onUserName(event.target.value)}
          />
        </label>

        {/* a busca some quando a pessoa só está trocando a letra de uma música que já está na fila */}
        <div className="search-block" hidden={Boolean(lyricsFor)}>
          <div className="row">
            <label className="field">
              Artista
              <input
                ref={artistRef}
                type="text"
                maxLength={200}
                autoComplete="off"
                enterKeyHint="next"
                value={artist}
                onChange={(event) => setArtist(event.target.value)}
              />
            </label>
            <label className="field">
              Nome da música
              <input
                ref={titleRef}
                type="text"
                maxLength={200}
                autoComplete="off"
                enterKeyHint="search"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
              />
            </label>
          </div>
          <button type="button" className="wide has-icon" disabled={searching} onClick={() => void runSearch()}>
            <Icon name="search" />
            Buscar no YouTube
          </button>
          <ul className="results" hidden={!results}>
            {(results ?? []).map((result) => {
              const open = preview?.id === result.video_id && preview.where === 'result';
              return (
                <li key={result.video_id}>
                  <div className="result-row">
                    <button
                      type="button"
                      className="result"
                      onClick={() => {
                        select(result.video_id, result.title);
                        fillConfirm(result.title);
                        clearResults();
                        setStatus('');
                      }}
                    >
                      <img src={result.thumbnail ?? thumbnailUrl(result.video_id)} alt="" loading="lazy" />
                      <span className="meta">
                        <strong>{result.title}</strong>
                        <small>{[result.channel, result.duration ? formatDuration(result.duration) : null].filter(Boolean).join(' · ')}</small>
                      </span>
                    </button>
                    <button
                      type="button"
                      className="preview-toggle"
                      aria-label={`Ouvir uma prévia de ${result.title}`}
                      onClick={() => setPreview(open ? null : { id: result.video_id, where: 'result' })}
                    >
                      {open ? 'Fechar' : 'Prévia'}
                    </button>
                  </div>
                  {open && (
                    <div className="inline-preview">
                      <VideoFrame videoId={result.video_id} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
        <div className="picked-box" hidden={!selected}>
          <p className="picked">{selected ? (selected.label ? `Selecionado: ${selected.label}` : `Link reconhecido: ${selected.id}`) : ''}</p>
          <button type="button" onClick={togglePreviewOfSelection}>
            {selectionPreview && selectionPreview.id === selected?.id ? 'Fechar prévia' : 'Ouvir no YouTube'}
          </button>
        </div>
        <div className="video-preview" hidden={!selectionPreview}>
          {selectionPreview && <VideoFrame videoId={selectionPreview.id} />}
        </div>
        <details className="link-box" hidden={Boolean(lyricsFor)} open={linkOpen} onToggle={(event) => setLinkOpen(event.currentTarget.open)}>
          <summary>Já tenho o link do vídeo</summary>
          <input
            type="text"
            placeholder="https://www.youtube.com/watch?v=…"
            aria-label="Link do vídeo do YouTube"
            value={url}
            onChange={(event) => onUrlChange(event.target.value)}
          />
        </details>

        {showConfirm && (
          <div className="confirm-box">
            <h3>Confirme a música</h3>
            <p className="hint">O artista e o nome são usados para buscar a letra e aparecem na fila. Corrija o que estiver errado.</p>
            <div className="row">
              <label className="field">
                Confirme o artista
                <input
                  type="text"
                  required={confirmRequired}
                  maxLength={200}
                  autoComplete="off"
                  value={confirmArtist}
                  onChange={(event) => setConfirmArtist(event.target.value)}
                />
              </label>
              <label className="field">
                Confirme o nome da música
                <input
                  type="text"
                  required={confirmRequired}
                  maxLength={200}
                  autoComplete="off"
                  value={confirmTitle}
                  onChange={(event) => setConfirmTitle(event.target.value)}
                />
              </label>
            </div>
          </div>
        )}

        <label className="field">
          Letra
          <select value={source} onChange={(event) => setSource(event.target.value)}>
            <option value="lrclib">Buscar a letra na internet</option>
            <option value="auto">Usar a legenda do vídeo, se ele tiver</option>
            <option value="align">Colar a letra e sincronizar com a voz (IA)</option>
            <option value="none">Cantar sem letra (só o instrumental)</option>
            <optgroup label="Avançado">
              <option value="file">Colar uma letra que já tem tempos (.lrc ou .srt)</option>
            </optgroup>
          </select>
        </label>
        <p className="hint">{SOURCE_HINTS[source] ?? ''}</p>
        <textarea
          rows={6}
          placeholder="Cole a letra aqui"
          aria-label="Letra"
          hidden={!needsText}
          required={needsText}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />

        <div className="row actions">
          <button type="submit" className="primary" disabled={submitting}>
            {lyricsFor ? 'Aplicar letra' : 'Adicionar à fila'}
          </button>
          <button
            type="button"
            hidden={!lyricsFor}
            onClick={() => {
              setLyricsFor(null);
              setStatus('');
            }}
          >
            Cancelar
          </button>
        </div>
        <p className={`hint${status.isError ? ' error' : ''}`} role="status">
          {status.text}
        </p>
      </form>
      {matches && (
        <JukeboxDialog
          songs={matches}
          busy={submitting}
          onUse={(song) => void useJukeboxSong(song)}
          onSearchYoutube={searchYoutubeAnyway}
          onClose={() => setMatches(null)}
        />
      )}
    </article>
  );
});
