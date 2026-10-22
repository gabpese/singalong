// The "we already have this song" notice: when the typed artist and name match songs ready in the Jukebox, the person
// picks one of them (it goes into the Queue right away) or goes on searching YouTube for another version.
import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n/index.ts';
import { keySummary } from '../lib/music.ts';
import { formatDuration, thumbnailUrl } from '../lib/queue-view.ts';
import type { LibrarySong } from '../lib/types.ts';

interface Props {
  songs: LibrarySong[];
  busy: boolean;
  onUse: (song: LibrarySong) => void;
  onSearchYoutube: () => void;
  /** Closed without choosing (Esc or a click outside): does nothing, the person goes back to the form. */
  onClose: () => void;
}

export function JukeboxDialog({ songs, busy, onUse, onSearchYoutube, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [chosenId, setChosenId] = useState(songs[0].video_id);
  const plural = songs.length > 1;
  const chosen = songs.find((song) => song.video_id === chosenId) ?? songs[0];

  // the native <dialog>: traps the focus, closes with Esc and darkens the rest of the screen
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
        if (event.target === event.currentTarget) onClose(); // a click on the dark backdrop
      }}
    >
      <div className="jukebox-body">
        <h2 id="jukebox-title">
          {t(plural ? 'juke.many' : 'juke.one')}
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
                  {song.video_title && <small className="video-title">{t('juke.onYoutube', { title: song.video_title })}</small>}
                </span>
              </label>
            </li>
          ))}
        </ul>
        <div className="jukebox-actions">
          <button type="button" className="primary" disabled={busy} onClick={() => onUse(chosen)}>
            {t(plural ? 'juke.useMany' : 'juke.useOne')}
          </button>
          <button type="button" disabled={busy} onClick={onSearchYoutube}>
            {t('juke.other')}
          </button>
        </div>
      </div>
    </dialog>
  );
}
