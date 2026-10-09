// Músicas já processadas (biblioteca), com filtro por artista e nome, para entrar na fila na hora ou baixar em MP4.
import { useRef, useState } from 'react';
import { downloadFile, EXPORT_PITCHES, exportFileName, requestExport } from '../lib/export-mp4.js';
import { api } from '../lib/identity.js';
import { keySummary } from '../lib/music.js';
import { filterSongs, formatDuration, formatPitch, sortSongs, thumbnailUrl } from '../lib/queue-view.js';
import type { ApiError, LibrarySong } from '../lib/types';
import { useRoom } from './context';

function LibraryRow({ song }: { song: LibrarySong }) {
  const { act, toast, myName } = useRoom();
  const [pitch, setPitch] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exportLabel, setExportLabel] = useState('Baixar MP4');

  /** Gera o MP4 da música no tom escolhido e baixa quando estiver pronto (o worker leva alguns segundos). */
  async function exportSong() {
    setExporting(true);
    try {
      toast('Gerando o vídeo… pode levar alguns segundos.');
      const url = await requestExport(api, song.video_id, pitch, { onWaiting: () => setExportLabel('Gerando…') });
      downloadFile(url, exportFileName(song, pitch));
      toast('Vídeo pronto! O download começou.');
    } catch (err) {
      toast((err as ApiError).message, true);
    } finally {
      setExportLabel('Baixar MP4');
      setExporting(false);
    }
  }

  async function add() {
    try {
      await act('POST', '/queue', { video_id: song.video_id, name: myName, display_title: song.title ?? undefined });
      toast('Adicionada à fila!');
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
        Adicionar
      </button>
      <div className="export-row">
        <span className="export-label">Vídeo MP4 para cantar offline</span>
        <span className="export-controls">
          <select aria-label="Tom do vídeo MP4" value={pitch} onChange={(event) => setPitch(Number(event.target.value))}>
            {EXPORT_PITCHES.map((value: number) => (
              <option key={value} value={value}>
                {`Tom ${formatPitch(value)}`}
              </option>
            ))}
          </select>
          <button
            type="button"
            title="Baixa um vídeo MP4 com o instrumental e a letra, para cantar offline"
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
  const count = !all.length ? '' : trimmed ? `(${shown.length} de ${all.length})` : `(${all.length})`;

  return (
    <article className="card">
      <h2>
        Músicas já processadas <span className="count">{count}</span>
      </h2>
      <p className="hint">Já estão prontas: entram na fila na hora.</p>
      <div className="filter">
        <input
          ref={filterRef}
          type="search"
          placeholder="Filtrar por artista ou nome…"
          aria-label="Filtrar as músicas já processadas"
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
        <p className="hint">{!all.length ? 'Nenhuma música processada ainda.' : `Nenhuma música encontrada para “${trimmed}”.`}</p>
        <button
          type="button"
          hidden={!(trimmed && !shown.length)}
          onClick={() => {
            setQuery('');
            filterRef.current?.focus();
          }}
        >
          Limpar filtro
        </button>
      </div>
    </article>
  );
}
