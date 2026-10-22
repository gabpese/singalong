// The "Tocando agora" card: the song, who is singing, the progress bar and the Host's controls.
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { getLanguage, t } from '../i18n/index.ts';
import { describeLyricsSource } from '../lib/lyrics-sync.ts';
import { keySummary } from '../lib/music.ts';
import { formatDuration, nextUp, progressPercent, splitQueue, thumbnailUrl } from '../lib/queue-view.ts';
import type { QueueItem, RoomState } from '../lib/types.ts';
import { Icon } from '../ui/Icon';
import { SingerBlobs } from '../ui/SingerBlobs';
import { useRoom } from './context';
import { BackingControl, GuideControl } from './BackingControl';
import { PitchControl } from './PitchControl';
import { ReactionBar } from './ReactionBar';
import { DuetControl } from './Duet';
import { InterludeBanner } from './InterludeBanner';
import { VoiceVolume } from './VoiceControl';
import type { Position } from './useRoomConnection';

const OFFSET_STEPS = [-0.5, -0.1, 0.1, 0.5];

/** "Próximo: Bia — Título" (and "(preparando…)" if it is not ready yet). */
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
 * The song's progress bar. For the Host it is a player: dragging changes the position (the TV goes to that point on
 * release). Everyone else only follows along.
 */
function Progress({ state, current, position }: { state: RoomState; current: QueueItem; position: Position }) {
  const { act, isHost } = useRoom();
  const [, tick] = useState(0);
  const [drag, setDrag] = useState<number | null>(null); // the second the bar is being dragged to
  const [hold, setHold] = useState<{ seconds: number; until: number } | null>(null); // keeps the target until the TV reports the new position
  const slider = useRef<HTMLInputElement>(null);
  const commitRef = useRef<(seconds: number) => void>(() => {});

  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 500); // the bar runs on its own between one position from the TV and the next
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
  // the native "change" only fires on RELEASING the bar (or on confirming with the keyboard): that is when the TV changes position
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
      <InterludeBanner state={state} />
      <div>
        {!current ? (
          <div className="now-content">
            {!state.interlude && (
              <p className="hint">
                {state.queue.length ? t('now.preparing') : t('now.nothing')}
              </p>
            )}
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
                  <SingerBlobs item={current} />
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
                  <button type="button" className="icon-btn" aria-label={t('player.skip')} title={t('player.skipTitle')} onClick={() => run('POST', '/player/skip', { item_id: current.id })}>
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
