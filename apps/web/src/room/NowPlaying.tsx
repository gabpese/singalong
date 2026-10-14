// Card "Tocando agora": a música, quem canta, a barra de progresso e os controles do anfitrião.
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { getLanguage, t } from '../i18n/index.js';
import { describeLyricsSource } from '../lib/lyrics-sync.js';
import { keySummary } from '../lib/music.js';
import { formatDuration, nextUp, progressPercent, splitQueue, thumbnailUrl } from '../lib/queue-view.js';
import type { QueueItem, RoomState } from '../lib/types';
import { Icon } from '../ui/Icon';
import { useRoom } from './context';
import { BackingControl, GuideControl } from './BackingControl';
import { PitchControl } from './PitchControl';
import { ReactionBar } from './ReactionBar';
import { DuetControl } from './Duet';
import { VoiceVolume } from './VoiceControl';
import type { Position } from './useRoomConnection';

const OFFSET_STEPS = [-0.5, -0.1, 0.1, 0.5];

/** "Próximo: Bia — Título" (e "(preparando…)" se ainda não está pronta). */
export function NextSinger({ state }: { state: RoomState }) {
  const next = nextUp(state);
  if (!next) return null;
  return (
    <p className="next-singer">
      {t('next.prefix')} <strong>{next.item.singers}</strong>
      <span className="muted">{` — ${next.item.title ?? next.item.video_id}${next.preparing ? ` ${t('next.preparing')}` : ''}`}</span>
    </p>
  );
}

/**
 * Barra de progresso da música. Para o anfitrião ela é um player: arrastar muda a posição (a TV vai para esse ponto ao
 * soltar). Os demais só acompanham.
 */
function Progress({ state, current, position }: { state: RoomState; current: QueueItem; position: Position }) {
  const { act, isHost } = useRoom();
  const [, tick] = useState(0);
  const [drag, setDrag] = useState<number | null>(null); // segundo para onde a barra está sendo arrastada
  const [hold, setHold] = useState<{ seconds: number; until: number } | null>(null); // mantém o destino até a TV informar a nova posição
  const slider = useRef<HTMLInputElement>(null);
  const commitRef = useRef<(seconds: number) => void>(() => {});

  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 500); // a barra anda sozinha entre uma posição da TV e a outra
    return () => clearInterval(timer);
  }, []);

  const duration = current.song.duration;
  const elapsed = state.playback === 'playing' ? performance.now() - position.at : 0;
  const playedMs = position.itemId === current.id ? position.ms + elapsed : 0;
  const holding = hold && performance.now() < hold.until ? hold.seconds : null;
  const shownSeconds = drag ?? holding ?? playedMs / 1000;

  commitRef.current = (seconds: number) => {
    setDrag(null);
    setHold({ seconds, until: performance.now() + 1500 });
    void act('POST', '/player/seek', { to: seconds }).catch(() => {});
  };
  // o "change" nativo só dispara ao SOLTAR a barra (ou ao confirmar pelo teclado): é aí que a TV muda de posição
  useEffect(() => {
    const element = slider.current;
    if (!element) return;
    const onChange = () => commitRef.current(Number(element.value));
    element.addEventListener('change', onChange);
    return () => element.removeEventListener('change', onChange);
  }, [isHost, duration]);

  const time = `${formatDuration(shownSeconds)}${duration ? ` / ${formatDuration(duration)}` : ''}`;
  if (!isHost || !duration) {
    return (
      <div className="progress">
        <div className="track">
          <div className="bar" style={{ width: `${progressPercent(playedMs, duration)}%` }} />
        </div>
        <span className="time">{time}</span>
      </div>
    );
  }
  const max = Math.floor(duration);
  const value = Math.min(Math.max(shownSeconds, 0), max);
  return (
    <div className="progress">
      <input
        ref={slider}
        type="range"
        className="seek"
        min={0}
        max={max}
        step={1}
        value={value}
        aria-label={t('now.progress')}
        aria-valuetext={formatDuration(value)}
        style={{ '--fill': `${(value / max) * 100}%` } as CSSProperties}
        onChange={(event) => setDrag(Number(event.target.value))}
      />
      <span className="time">{time}</span>
    </div>
  );
}

export function NowPlaying({ state, position }: { state: RoomState; position: Position }) {
  const { act, isHost, react } = useRoom();
  const { current } = splitQueue(state);
  const run = (method: string, path: string, body?: unknown) => void act(method, path, body).catch(() => {});

  return (
    <article className="card now">
      <h2>{t('now.title')}</h2>
      <div>
        {!current ? (
          <div className="now-content">
            <p className="hint">
              {state.queue.length ? t('now.preparing') : t('now.nothing')}
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
                  {` ${t(current.guest?.status === 'accepted' ? 'now.singing.many' : 'now.singing.one', { who: current.singers })}`}
                </span>
                {current.song.key && <span className="muted small">{keySummary(current.song.key, current.pitch)}</span>}
                <span className="muted small">{t('now.lyrics', { source: describeLyricsSource(current.song.lyrics_source) })}</span>
              </div>
            </div>
            <Progress state={state} current={current} position={position} />
            <ReactionBar onReact={react} />
            <NextSinger state={state} />
            <div className="controls-row">
              {isHost && (
                <>
                  <button
                    type="button"
                    className="icon-btn"
                    aria-label={t(state.playback === 'paused' ? 'player.resume' : 'player.pause')}
                    title={t(state.playback === 'paused' ? 'player.resume' : 'player.pause')}
                    onClick={() => run('POST', `/player/${state.playback === 'paused' ? 'resume' : 'pause'}`)}
                  >
                    <Icon name={state.playback === 'paused' ? 'resume' : 'pause'} />
                  </button>
                  <button type="button" className="icon-btn" aria-label={t('player.skip')} title={t('player.skipTitle')} onClick={() => run('POST', '/player/skip')}>
                    <Icon name="next-song" />
                  </button>
                </>
              )}
              <PitchControl item={current} />
            </div>
            <BackingControl item={current} />
            <GuideControl item={current} />
            <VoiceVolume />
            <DuetControl item={current} />
            {isHost && (
              <div className="controls-row offset">
                <span className="muted">{t('now.offset')}</span>
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
                <span className="offset-value">{`${current.lyric_offset.toLocaleString(getLanguage(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`}</span>
              </div>
            )}
            {!state.tv_connected && (
              <p className="hint error">{t('now.noTv')}</p>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
