// The "Adicionar música" panel. The person looks for the video as on YouTube: by the artist, by the song's name or both
// (one is enough). Before going to YouTube, it checks whether the song is already ready in the Jukebox. After choosing the
// video, the person confirms the artist and the song's name (both are required: they feed the lyrics search and what shows
// in the Queue). The video's link is an alternative for whoever already has it.
// It knows nothing about Rooms: whoever uses it passes the functions that send the request (submitNew) and that change the
// lyrics of an item that asks for them (submitLyrics).
import { forwardRef, type FormEvent, useImperativeHandle, useRef, useState } from 'react';
import { t } from '../i18n/index.ts';
import { api } from '../lib/identity.ts';
import { findJukeboxMatches, formatDuration, thumbnailUrl } from '../lib/queue-view.ts';
import { buildSearchQuery, embedUrl, extractVideoId, guessArtistTitle, watchUrl } from '../lib/youtube.ts';
import type { ApiError, LibrarySong, SearchResult } from '../lib/types.ts';
import { Icon } from '../ui/Icon';
import { JukeboxDialog } from './JukeboxDialog';

// the options where the person pastes a text
const TEXT_SOURCES = ['file', 'align'];

interface NewSong {
  url: string;
  lyrics: { source: string; text?: string };
  artist: string;
  title: string;
  display_title: string;
}

export interface AddSongHandle {
  /** Opens the panel already in "choose the lyrics" mode for an item in the Queue whose lyrics were not found. */
  chooseLyrics(videoId: string, reason: string | null, names?: { artist?: string | null; title?: string | null }): void;
}

interface Props {
  userName: string;
  onUserName: (name: string) => void;
  /** Sends the request and returns the success message. */
  submitNew: (song: NewSong) => Promise<string>;
  submitLyrics: (videoId: string, body: Record<string, unknown>) => Promise<string>;
  /** The panel needs to show (e.g. opening the "Adicionar" tab). */
  onShow: () => void;
  /** Songs already ready (the Jukebox): if what was typed matches one, the person can use it instead of searching YouTube. */
  jukebox: LibrarySong[];
  /** Puts a ready song from the Jukebox in the Queue and returns the success message. */
  onPickJukebox: (song: LibrarySong) => Promise<string>;
  /** The Room code: the YouTube search is answered by the agent of the Owner whose Session the Room is in (without one, by the classic worker). */
  room?: string;
}

/** YouTube's official player in a frame: to check it is the right song before adding it. */
function VideoFrame({ videoId }: { videoId: string }) {
  return (
    <div className="video-frame">
      <iframe
        src={embedUrl(videoId)}
        title={t('frame.title')}
        allow="autoplay; encrypted-media; picture-in-picture"
        allowFullScreen
        referrerPolicy="strict-origin-when-cross-origin"
      />
      <a href={watchUrl(videoId)} target="_blank" rel="noopener">
        {t('frame.fail')}
      </a>
    </div>
  );
}

type Preview = { id: string; where: 'selection' | 'result' } | null;

export const AddSong = forwardRef<AddSongHandle, Props>(function AddSong(
  { userName, onUserName, submitNew, submitLyrics, onShow, jukebox, onPickJukebox, room },
  ref,
) {
  // what the person types to SEARCH (one of the two is enough)
  const [artist, setArtist] = useState('');
  const [title, setTitle] = useState('');
  // what they CONFIRM after choosing the video (both are required)
  const [confirmArtist, setConfirmArtist] = useState('');
  const [confirmTitle, setConfirmTitle] = useState('');
  const [url, setUrl] = useState('');
  const [source, setSource] = useState('lrclib');
  const [text, setText] = useState('');
  const [linkOpen, setLinkOpen] = useState(false);
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [status, setStatusState] = useState({ text: '', isError: false });
  const [selected, setSelected] = useState<{ id: string; label: string | null } | null>(null); // the chosen video (or one pasted as a link)
  const [preview, setPreview] = useState<Preview>(null); // the open YouTube preview (only one at a time)
  const [lyricsFor, setLyricsFor] = useState<string | null>(null); // the video waiting for the lyrics choice (an item in needs_lyrics)
  const [searching, setSearching] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [matches, setMatches] = useState<LibrarySong[] | null>(null); // the ready versions found (opens the notice)
  const [declinedFor, setDeclinedFor] = useState(''); // the search in which the person preferred YouTube to the Jukebox
  const nameRef = useRef<HTMLInputElement>(null);
  const artistRef = useRef<HTMLInputElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);

  const setStatus = (message: string, isError = false) => setStatusState({ text: message, isError });
  const needsText = TEXT_SOURCES.includes(source);
  // Confirming the artist and the name is required; only not when changing the lyrics of an item already in the Queue (unless the online search needs them)
  const confirmRequired = !lyricsFor || source === 'lrclib';
  const showConfirm = Boolean(selected) || Boolean(lyricsFor);
  const names = () => ({ artist: confirmArtist.replace(/\s+/g, ' ').trim(), title: confirmTitle.replace(/\s+/g, ' ').trim() });
  const lyricsPayload = () => ({ source, ...(needsText ? { text } : {}) });

  function select(videoId: string | null, label: string | null = null) {
    setSelected(videoId ? { id: videoId, label } : null);
    setUrl(videoId ? watchUrl(videoId) : '');
  }

  /** Prefills the confirmation: what the person typed in the search wins; whatever is missing comes from a guess at the video's title. */
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
    // the person's name stays (it is not a field of this form)
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
      setStatus(t('add.s.needQuery'), true);
      (artist.trim() ? titleRef : artistRef).current?.focus();
      return;
    }
    // before going to YouTube: do we already have this song ready? (not when changing the lyrics of an item already in the Queue)
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
    setStatus(t('add.s.searching', { query }));
    try {
      const found = await api<SearchResult[]>('GET', `/api/search?q=${encodeURIComponent(query)}`, undefined, room);
      if (!found.length) {
        clearResults();
        return setStatus(t('add.s.nothing'), true);
      }
      setPreview(null);
      setResults(found);
      setStatus(t('add.s.pick'));
    } catch (err) {
      clearResults();
      setStatus((err as ApiError).message, true);
    } finally {
      setSearching(false);
    }
  }

  function onUrlChange(value: string) {
    // a link pasted by hand: counts as the selection (if it is not a YouTube link, there is no selection)
    setUrl(value);
    const id: string | null = extractVideoId(value);
    if (id && !selected) fillConfirm(null); // no video title to guess from: uses what was typed in the search
    setSelected(id ? { id, label: null } : null);
    if (preview && preview.id !== id) setPreview(null);
  }

  /** Without the name the Queue fills up with "Alguém": before taking a song, the name is required. */
  function nameMissing(): boolean {
    if (userName.trim()) return false;
    setStatus(t('add.s.needName'), true);
    nameRef.current?.focus();
    nameRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return true;
  }

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    // Enter in the search fields, with no video chosen yet: searches for the video
    if (!lyricsFor && !selected) return runSearch();
    if (nameMissing()) return;
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
          display_title: cleanTitle, // the Queue shows the name the person confirmed, not the video's (sometimes messy) title
        });
      }
      clearResults();
      reset();
      setStatus(message ?? t('add.s.done'));
    } catch (err) {
      setStatus((err as ApiError).message, true);
    } finally {
      setSubmitting(false);
    }
  }

  async function useJukeboxSong(song: LibrarySong) {
    if (nameMissing()) return;
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

  /** "Buscar outra versão no YouTube": goes on with the search and does not ask again for this same search. */
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
      setStatus(t('add.s.chooseLyrics', { reason: reason ?? t('add.s.chooseLyricsDefault') }), true);
    },
  }));

  const selectionPreview = preview?.where === 'selection' ? preview : null;

  return (
    <article className="card add">
      <h2>{t('add.title')}</h2>
      <form autoComplete="off" onSubmit={onSubmit}>
        <label className="field">
          <span>
            {t('add.name')} <span className="required" aria-hidden="true">*</span>
          </span>
          <input
            ref={nameRef}
            type="text"
            maxLength={30}
            placeholder={t('add.namePh')}
            autoComplete="nickname"
            value={userName}
            onChange={(event) => onUserName(event.target.value)}
          />
        </label>

        {/* the search goes away when the person is only changing the lyrics of a song already in the Queue */}
        <div className="search-block" hidden={Boolean(lyricsFor)}>
          <div className="row">
            <label className="field">
              {t('add.artist')}
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
              {t('add.songName')}
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
            {t('add.search')}
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
                      aria-label={t('add.previewAria', { title: result.title })}
                      onClick={() => setPreview(open ? null : { id: result.video_id, where: 'result' })}
                    >
                      {open ? t('add.close') : t('add.preview')}
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
          <p className="picked">{selected ? (selected.label ? t('add.selected', { label: selected.label }) : t('add.linkKnown', { id: selected.id })) : ''}</p>
          <button type="button" onClick={togglePreviewOfSelection}>
            {selectionPreview && selectionPreview.id === selected?.id ? t('add.closePreview') : t('add.listenYt')}
          </button>
        </div>
        <div className="video-preview" hidden={!selectionPreview}>
          {selectionPreview && <VideoFrame videoId={selectionPreview.id} />}
        </div>
        <details className="link-box" hidden={Boolean(lyricsFor)} open={linkOpen} onToggle={(event) => setLinkOpen(event.currentTarget.open)}>
          <summary>{t('add.haveLink')}</summary>
          <input
            type="text"
            placeholder="https://www.youtube.com/watch?v=…"
            aria-label={t('add.linkAria')}
            value={url}
            onChange={(event) => onUrlChange(event.target.value)}
          />
        </details>

        {showConfirm && (
          <div className="confirm-box">
            <h3>{t('add.confirm.title')}</h3>
            <p className="hint">{t('add.confirm.hint')}</p>
            <div className="row">
              <label className="field">
                {t('add.confirmArtist')}
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
                {t('add.confirmSong')}
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
          {t('add.lyrics')}
          <select value={source} onChange={(event) => setSource(event.target.value)}>
            <option value="lrclib">{t('add.opt.lrclib')}</option>
            <option value="auto">{t('add.opt.auto')}</option>
            <option value="align">{t('add.opt.align')}</option>
            <option value="none">{t('add.opt.none')}</option>
            <optgroup label={t('add.opt.advanced')}>
              <option value="file">{t('add.opt.file')}</option>
            </optgroup>
          </select>
        </label>
        <p className="hint">{['lrclib', 'auto', 'align', 'none', 'file'].includes(source) ? t(`add.hint.${source}`) : ''}</p>
        <textarea
          rows={6}
          placeholder={t('add.lyricsPh')}
          aria-label={t('add.lyrics')}
          hidden={!needsText}
          required={needsText}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />

        <div className="row actions">
          <button type="submit" className="primary" disabled={submitting}>
            {lyricsFor ? t('add.apply') : t('add.submit')}
          </button>
          <button
            type="button"
            hidden={!lyricsFor}
            onClick={() => {
              setLyricsFor(null);
              setStatus('');
            }}
          >
            {t('add.cancel')}
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
