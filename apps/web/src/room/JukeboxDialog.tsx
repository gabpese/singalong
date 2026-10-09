// Aviso "já temos esta música": quando o artista e o nome digitados batem com músicas prontas no Jukebox, a pessoa
// escolhe uma delas (entra na fila na hora) ou segue a busca de outra versão no YouTube.
import { useEffect, useRef, useState } from 'react';
import { keySummary } from '../lib/music.js';
import { formatDuration, thumbnailUrl } from '../lib/queue-view.js';
import type { LibrarySong } from '../lib/types';

interface Props {
  songs: LibrarySong[];
  busy: boolean;
  onUse: (song: LibrarySong) => void;
  onSearchYoutube: () => void;
  /** Fechou sem escolher (Esc ou clique fora): não faz nada, a pessoa volta ao formulário. */
  onClose: () => void;
}

export function JukeboxDialog({ songs, busy, onUse, onSearchYoutube, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [chosenId, setChosenId] = useState(songs[0].video_id);
  const plural = songs.length > 1;
  const chosen = songs.find((song) => song.video_id === chosenId) ?? songs[0];

  // <dialog> nativo: prende o foco, fecha com Esc e escurece o resto da tela
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);

  return (
    <dialog
      ref={dialog}
      className="jukebox-dialog"
      aria-labelledby="jukebox-title"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose(); // clique no fundo escuro
      }}
    >
      <div className="jukebox-body">
        <h2 id="jukebox-title">
          {plural
            ? 'Encontramos estas versões prontas no nosso Jukebox, quer selecionar uma destas?'
            : 'Encontramos esta versão pronta no nosso Jukebox, quer selecioná-la?'}
        </h2>
        <ul className="jukebox-options">
          {songs.map((song) => (
            <li key={song.video_id}>
              <label className={`jukebox-option${plural ? '' : ' single'}`}>
                <input
                  type="radio"
                  name="jukebox-song"
                  checked={song.video_id === chosen.video_id}
                  onChange={() => setChosenId(song.video_id)}
                />
                <img src={thumbnailUrl(song.video_id)} alt="" loading="lazy" />
                <span className="meta">
                  <strong>{song.title ?? song.video_id}</strong>
                  <small>{[song.artist, song.duration ? formatDuration(song.duration) : null].filter(Boolean).join(' · ')}</small>
                  {song.key && <small>{keySummary(song.key)}</small>}
                </span>
              </label>
            </li>
          ))}
        </ul>
        <div className="jukebox-actions">
          <button type="button" className="primary" disabled={busy} onClick={() => onUse(chosen)}>
            {plural ? 'Usar a versão selecionada' : 'Usar esta versão'}
          </button>
          <button type="button" disabled={busy} onClick={onSearchYoutube}>
            Buscar outra versão no YouTube
          </button>
        </div>
      </div>
    </dialog>
  );
}
