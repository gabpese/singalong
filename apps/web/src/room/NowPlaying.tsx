// Card "Tocando agora": a música, quem canta, a barra de progresso e os controles do anfitrião.
import { useEffect, useState } from 'react';
import { describeLyricsSource } from '../lib/lyrics-sync.js';
import { keySummary } from '../lib/music.js';
import { formatDuration, nextUp, progressPercent, splitQueue, thumbnailUrl } from '../lib/queue-view.js';
import type { QueueItem, RoomState } from '../lib/types';
import { Icon } from '../ui/Icon';
import { useRoom } from './context';
import { PitchControl } from './PitchControl';
import type { Position } from './useRoomConnection';

const OFFSET_STEPS = [-0.5, -0.1, 0.1, 0.5];

/** "Próximo: Bia — Título" (e "(preparando…)" se ainda não está pronta). */
export function NextSinger({ state }: { state: RoomState }) {
  const next = nextUp(state);
  if (!next) return null;
  return (
    <p className="next-singer">
      Próximo: <strong>{next.item.added_by}</strong>
      <span className="muted">{` — ${next.item.title ?? next.item.video_id}${next.preparing ? ' (preparando…)' : ''}`}</span>
    </p>
  );
}

function Progress({ state, current, position }: { state: RoomState; current: QueueItem; position: Position }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 500); // a barra anda sozinha entre uma posição da TV e a outra
    return () => clearInterval(timer);
  }, []);
  const elapsed = state.playback === 'playing' ? performance.now() - position.at : 0;
  const ms = position.itemId === current.id ? position.ms + elapsed : 0;
  const duration = current.song.duration;
  return (
    <div className="progress">
      <div className="track">
        <div className="bar" style={{ width: `${progressPercent(ms, duration)}%` }} />
      </div>
      <span className="time">{`${formatDuration(ms / 1000)}${duration ? ` / ${formatDuration(duration)}` : ''}`}</span>
    </div>
  );
}

export function NowPlaying({ state, position }: { state: RoomState; position: Position }) {
  const { act, isHost } = useRoom();
  const { current } = splitQueue(state);
  const run = (method: string, path: string, body?: unknown) => void act(method, path, body).catch(() => {});

  return (
    <article className="card now">
      <h2>Tocando agora</h2>
      <div>
        {!current ? (
          <div className="now-content">
            <p className="hint">
              {state.queue.length
                ? 'Preparando a próxima música… ela começa sozinha quando estiver pronta.'
                : 'Nada tocando. Toque em Adicionar para escolher uma música.'}
            </p>
            <NextSinger state={state} />
          </div>
        ) : (
          <div className="now-content">
            <div className="now-main">
              <img src={thumbnailUrl(current.video_id)} alt="" className="thumb" />
              <div className="now-info">
                <strong>{current.title ?? current.video_id}</strong>
                {current.artist && <span className="muted">{current.artist}</span>}
                <span className="now-singer">
                  <Icon name="singing" />
                  {` ${current.added_by} está cantando`}
                </span>
                {current.song.key && <span className="muted small">{keySummary(current.song.key, current.pitch)}</span>}
                <span className="muted small">{`Letra: ${describeLyricsSource(current.song.lyrics_source)}`}</span>
              </div>
            </div>
            <Progress state={state} current={current} position={position} />
            <NextSinger state={state} />
            <div className="controls-row">
              {isHost && (
                <>
                  <button type="button" onClick={() => run('POST', `/player/${state.playback === 'paused' ? 'resume' : 'pause'}`)}>
                    {state.playback === 'paused' ? 'Retomar' : 'Pausar'}
                  </button>
                  <button type="button" aria-label="Voltar 10 segundos" onClick={() => run('POST', '/player/seek', { seconds: -10 })}>
                    ⏪ 10s
                  </button>
                  <button type="button" aria-label="Avançar 10 segundos" onClick={() => run('POST', '/player/seek', { seconds: 10 })}>
                    10s ⏩
                  </button>
                  <button type="button" onClick={() => run('POST', '/player/skip')}>
                    Pular
                  </button>
                </>
              )}
              <PitchControl item={current} />
            </div>
            {isHost && (
              <div className="controls-row offset">
                <span className="muted">Ajuste da letra</span>
                {OFFSET_STEPS.map((step) => (
                  <button
                    key={step}
                    type="button"
                    onClick={() =>
                      run('PUT', `/songs/${current.video_id}/offset`, { offset: Math.round((current.lyric_offset + step) * 100) / 100 })
                    }
                  >
                    {`${step > 0 ? '+' : '−'}${Math.abs(step)} s`}
                  </button>
                ))}
                <span className="offset-value">{`${current.lyric_offset.toFixed(1).replace('.', ',')} s`}</span>
              </div>
            )}
            {!state.tv_connected && (
              <p className="hint error">A TV não está conectada: abra o menu (⋯) e toque em “Abrir TV” para a música tocar.</p>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
