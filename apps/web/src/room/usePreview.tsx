// The instrumental's preview on the phone, with a key change: the state, the link to the audio player and the bar on screen.
import { t } from '../i18n/index.ts';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { keySummary } from '../lib/music.ts';
import { createPreviewPlayer } from '../lib/preview.ts';
import type { QueueItem, RoomState, SongKey } from '../lib/types.ts';
import { Icon } from '../ui/Icon';
import { clampPitch, PitchPicker } from './PitchControl';

interface PreviewItem {
  id: number;
  video_id: string;
  title: string;
  can_edit: boolean;
  key: SongKey | null;
}

type Act = (method: string, path: string, body?: unknown) => Promise<unknown>;

export function usePreview(state: RoomState | null, act: Act) {
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const [player] = useState(() => createPreviewPlayer({ onEnded: () => rerender() }));
  const [item, setItem] = useState<PreviewItem | null>(null);
  const [pitch, setPitch] = useState(0);
  const [hint, setHint] = useState('');
  // the player and the asynchronous answers read these values: refs avoid reading a stale state
  const itemRef = useRef<PreviewItem | null>(null);
  const pitchRef = useRef(0);
  itemRef.current = item;
  pitchRef.current = pitch;

  const changePitch = useCallback(
    (value: number) => {
      pitchRef.current = value;
      setPitch(value);
      player.setPitch(value);
    },
    [player],
  );

  const close = useCallback(() => {
    player.unload();
    itemRef.current = null;
    setItem(null);
  }, [player]);

  const open = useCallback(
    async (queueItem: QueueItem) => {
      const opened: PreviewItem = {
        id: queueItem.id,
        video_id: queueItem.video_id,
        title: queueItem.title ?? queueItem.video_id,
        can_edit: queueItem.can_edit,
        key: queueItem.song.key,
      };
      itemRef.current = opened;
      setItem(opened);
      changePitch(queueItem.pitch);
      setHint(t('preview.loading'));
      try {
        if (!(await player.load(queueItem.song.media!.instrumental))) return; // another preview was requested
        await player.play();
        setHint(
          queueItem.can_edit
            ? t('preview.hintOwn')
            : t('preview.hintOther'),
        );
      } catch (err) {
        setHint(t('preview.fail', { error: (err as Error).message }));
      }
      rerender();
    },
    [player, changePitch],
  );

  const stepPitch = useCallback(
    (delta: number) => {
      const current = itemRef.current;
      if (!current) return;
      const next = clampPitch(pitchRef.current + delta);
      changePitch(next);
      if (current.can_edit) void act('PATCH', `/queue/${current.id}`, { pitch: next }).catch(() => {});
    },
    [act, changePitch],
  );

  const togglePlay = useCallback(async () => {
    if (!player.loaded) return;
    if (player.playing) player.pause();
    else await player.play();
    rerender();
  }, [player]);

  // the position and the play/pause button follow the audio
  useEffect(() => {
    if (!item) return;
    const timer = setInterval(rerender, 400);
    return () => clearInterval(timer);
  }, [item]);

  /** Keeps the preview in line with the Queue: closes if the item left or started playing on the TV; follows the key. */
  useEffect(() => {
    const current = itemRef.current;
    if (!current || !state) return;
    const queued = state.queue.find((candidate) => candidate.id === current.id);
    if (!queued || queued.id === state.current_item_id) return close();
    if (queued.can_edit !== current.can_edit || queued.song.key !== current.key) {
      setItem({ ...current, can_edit: queued.can_edit, key: queued.song.key });
    }
    if (queued.can_edit && queued.pitch !== pitchRef.current) changePitch(queued.pitch); // the key was changed by another control
  }, [state, close, changePitch]);

  // the preview bar takes up room in the footer: the CSS reserves that area while it is open
  useEffect(() => {
    document.body.classList.toggle('has-preview', Boolean(item));
    return () => document.body.classList.remove('has-preview');
  }, [item]);

  return { player, item, pitch, hint, open, close, stepPitch, togglePlay };
}

export type PreviewControls = ReturnType<typeof usePreview>;

/** The fixed bar with the preview: play/pause, position, key and close. */
export function PreviewBar({ preview }: { preview: PreviewControls }) {
  const { player, item, pitch, hint, close, stepPitch, togglePlay } = preview;
  const dragging = useRef(false);
  const [dragValue, setDragValue] = useState(0);
  const playing = player.playing;
  const playedValue = player.duration ? Math.round((player.position / player.duration) * 1000) : 0;

  return (
    <aside className="preview-bar" hidden={!item} aria-label={t('preview.aria')}>
      <div className="preview-info">
        <strong>{item?.title}</strong>
        <span className="muted small">{item ? keySummary(item.key, pitch) : ''}</span>
      </div>
      <div className="preview-controls">
        <button type="button" className="icon-btn" aria-label={t('preview.playPause')} onClick={() => void togglePlay()}>
          <Icon name={playing ? 'pause' : 'resume'} />
        </button>
        <input
          type="range"
          min={0}
          max={1000}
          aria-label={t('preview.position')}
          value={dragging.current ? dragValue : playedValue}
          onPointerDown={() => {
            dragging.current = true;
            setDragValue(playedValue);
          }}
          onPointerUp={() => {
            dragging.current = false;
          }}
          onPointerCancel={() => {
            dragging.current = false;
          }}
          onChange={(event) => {
            setDragValue(Number(event.target.value));
            player.seek(Number(event.target.value) / 1000);
          }}
        />
        <PitchPicker pitch={pitch} songKey={item?.key ?? null} onChange={(value) => stepPitch(value - pitch)} />
        <button type="button" aria-label={t('preview.close')} onClick={close}>
          ✕
        </button>
      </div>
      <p className="hint small">{hint}</p>
    </aside>
  );
}
