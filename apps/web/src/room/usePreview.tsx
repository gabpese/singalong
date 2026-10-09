// Prévia do instrumental no celular, com troca de tom: o estado, a ligação com o player de áudio e a barra na tela.
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { keySummary } from '../lib/music.js';
import { createPreviewPlayer } from '../lib/preview.js';
import { formatPitch } from '../lib/queue-view.js';
import type { QueueItem, RoomState, SongKey } from '../lib/types';
import { clampPitch } from './PitchControl';

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
  // o player e as respostas assíncronas leem estes valores: refs evitam ler um estado já velho
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
      setHint('Carregando a música…');
      try {
        if (!(await player.load(queueItem.song.media!.instrumental))) return; // outra prévia foi pedida
        await player.play();
        setHint(
          queueItem.can_edit
            ? 'Mudar o tom aqui muda o tom da sua música na fila.'
            : 'Esta música é de outra pessoa: o tom aqui vale só para a sua prévia.',
        );
      } catch (err) {
        setHint(`Não consegui tocar a prévia: ${(err as Error).message}`);
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

  // posição e botão de tocar/pausar acompanham o áudio
  useEffect(() => {
    if (!item) return;
    const timer = setInterval(rerender, 400);
    return () => clearInterval(timer);
  }, [item]);

  /** Mantém a prévia coerente com a fila: fecha se o item saiu ou começou a tocar na TV; acompanha o tom. */
  useEffect(() => {
    const current = itemRef.current;
    if (!current || !state) return;
    const queued = state.queue.find((candidate) => candidate.id === current.id);
    if (!queued || queued.id === state.current_item_id) return close();
    if (queued.can_edit !== current.can_edit || queued.song.key !== current.key) {
      setItem({ ...current, can_edit: queued.can_edit, key: queued.song.key });
    }
    if (queued.can_edit && queued.pitch !== pitchRef.current) changePitch(queued.pitch); // o tom foi mudado por outro controle
  }, [state, close, changePitch]);

  // a barra de prévia ocupa espaço no rodapé: o CSS reserva essa área enquanto ela está aberta
  useEffect(() => {
    document.body.classList.toggle('has-preview', Boolean(item));
    return () => document.body.classList.remove('has-preview');
  }, [item]);

  return { player, item, pitch, hint, open, close, stepPitch, togglePlay };
}

export type PreviewControls = ReturnType<typeof usePreview>;

/** Barra fixa com a prévia: tocar/pausar, posição, tom e fechar. */
export function PreviewBar({ preview }: { preview: PreviewControls }) {
  const { player, item, pitch, hint, close, stepPitch, togglePlay } = preview;
  const dragging = useRef(false);
  const [dragValue, setDragValue] = useState(0);
  const playing = player.playing;
  const playedValue = player.duration ? Math.round((player.position / player.duration) * 1000) : 0;

  return (
    <aside className="preview-bar" hidden={!item} aria-label="Prévia da música">
      <div className="preview-info">
        <strong>{item?.title}</strong>
        <span className="muted small">{item ? keySummary(item.key, pitch) : ''}</span>
      </div>
      <div className="preview-controls">
        {/* U+FE0E força o símbolo em texto: sem ele alguns celulares desenham o emoji colorido */}
        <button type="button" aria-label="Tocar ou pausar a prévia" onClick={() => void togglePlay()}>
          {playing ? '⏸︎' : '▶︎'}
        </button>
        <input
          type="range"
          min={0}
          max={1000}
          aria-label="Posição da prévia"
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
        <span className="pitch">
          <button type="button" aria-label="Tom mais grave" onClick={() => stepPitch(-1)}>
            −
          </button>
          <span className="pitch-value">{`Tom ${formatPitch(pitch)}`}</span>
          <button type="button" aria-label="Tom mais agudo" onClick={() => stepPitch(1)}>
            +
          </button>
        </span>
        <button type="button" aria-label="Fechar a prévia" onClick={close}>
          ✕
        </button>
      </div>
      <p className="hint small">{hint}</p>
    </aside>
  );
}
