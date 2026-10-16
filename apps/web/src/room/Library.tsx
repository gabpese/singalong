// Músicas já processadas (biblioteca), com filtro por artista e nome, para entrar na fila na hora ou baixar em MP4.
import { useRef, useState } from 'react';
import { t } from '../i18n/index.js';
import { downloadFile, EXPORT_PITCHES, exportFileName, requestExport } from '../lib/export-mp4.js';
import { api } from '../lib/identity.js';
import { keySummary, pitchLabel } from '../lib/music.js';
import { filterSongs, formatDuration, sortSongs, thumbnailUrl } from '../lib/queue-view.js';
import type { ApiError, LibrarySong } from '../lib/types';
import { useRoom } from './context';

function LibraryRow({ song }: { song: LibrarySong }) {
  const { act, toast, myName, code } = useRoom();
  const [pitch, setPitch] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exportLabel, setExportLabel] = useState(t('library.exportButton'));

  /** Gera o MP4 da música no tom escolhido e baixa quando estiver pronto (o worker leva alguns segundos). */
  async function exportSong() {
    setExporting(true);
    try {
      toast(t('library.exportStart'));
      const url = await requestExport((method, path, body) => api(method, path, body, code), song.video_id, pitch, { onWaiting: () => setExportLabel(t('library.exportMaking')) });
      downloadFile(url, exportFileName(song, pitch));
      toast(t('library.exportDone'));
    } catch (err) {
      toast((err as ApiError).message, true);
    } finally {
      setExportLabel(t('library.exportButton'));
      setExporting(false);
    }
  }

  async function add() {
    try {
      await act('POST', '/queue', { video_id: song.video_id, name: myName, display_title: song.title ?? undefined });
      toast(t('library.added'));
    } catch {
      // o erro já apareceu no aviso
    }
  }

  return (
    <li>
      <img src={thumbnailUrl(song.video_id)} alt="" className="thumb" loading="lazy" />
      <div className="info">
        <strong>{song.title ?? song.video_id}</strong>
        <span className="muted">{[song.artist, song.duration ? formatDuration(song.duration) : null].filter(Boolean).join(' · ')}</span>
        {song.key && <span className="muted small">{keySummary(song.key)}</span>}
      </div>
      <button type="button" className="primary" onClick={add}>
        {t('library.add')}
      </button>
      <div className="export-row">
        <span className="export-label">{t('library.exportLabel')}</span>
        <span className="export-controls">
          <select aria-label={t('library.exportPitch')} value={pitch} onChange={(event) => setPitch(Number(event.target.value))}>
            {EXPORT_PITCHES.map((value: number) => (
              <option key={value} value={value}>
                {pitchLabel(value)}
              </option>
            ))}
          </select>
          <button
            type="button"
            title={t('library.exportTitle')}
            disabled={exporting}
            onClick={exportSong}
          >
            {exportLabel}
          </button>
        </span>
      </div>
    </li>
  );
}

export function Library({ songs }: { songs: LibrarySong[] }) {
  const [query, setQuery] = useState('');
  const filterRef = useRef<HTMLInputElement>(null);
  const all: LibrarySong[] = sortSongs(songs);
  const trimmed = query.trim();
  const shown: LibrarySong[] = filterSongs(all, trimmed);
  const count = !all.length ? '' : trimmed ? t('library.count', { n: shown.length, total: all.length }) : `(${all.length})`;

  return (
    <article className="card">
      <h2>
        {t('library.title')} <span className="count">{count}</span>
      </h2>
      <p className="hint">{t('library.hint')}</p>
      <div className="filter">
        <input
          ref={filterRef}
          type="search"
          placeholder={t('library.filterPlaceholder')}
          aria-label={t('library.filterAria')}
          autoComplete="off"
          enterKeyHint="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <ul className="library">
        {shown.map((song) => (
          <LibraryRow key={song.video_id} song={song} />
        ))}
      </ul>
      <div className="empty-box" hidden={shown.length > 0}>
        <p className="hint">{!all.length ? t('library.none') : t('library.noMatch', { query: trimmed })}</p>
        <button
          type="button"
          hidden={!(trimmed && !shown.length)}
          onClick={() => {
            setQuery('');
            filterRef.current?.focus();
          }}
        >
          {t('library.clear')}
        </button>
      </div>
    </article>
  );
}
