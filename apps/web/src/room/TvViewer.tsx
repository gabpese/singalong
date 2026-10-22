// The Room's TV tab: whoever is on the phone follows the lyrics, who is singing and the Queue. It only watches: the sound and the microphone
// belong to the device that opened the TV as the player (tv.html), so two devices never play the same song.
import { useEffect, useRef } from 'react';
import { t } from '../i18n/index.ts';
import { createSyncClock } from '../lib/clock.ts';
import { keySummary } from '../lib/music.ts';
import { createLyricsView } from '../lib/lyrics-view.ts';
import { nextUp, playOrder, splitQueue } from '../lib/queue-view.ts';
import type { LyricCue, RoomState } from '../lib/types.ts';
import { SingerBlobs } from '../ui/SingerBlobs';
import { LyricsSize } from '../ui/LyricsSize';
import { QueueBox, titleOf } from '../tv/QueueBox';
import { InterludeBanner } from './InterludeBanner';
import { ReactionBar } from './ReactionBar';
import { useRoom } from './context';
import type { Position } from './useRoomConnection';

interface Props {
  state: RoomState | null;
  position: Position;
  lyrics: { itemId: number; cues: LyricCue[] } | null;
}

export function TvViewer({ state, position, lyrics }: Props) {
  const { react } = useRoom();
  const refs = {
    prev: useRef<HTMLParagraphElement>(null),
    current: useRef<HTMLParagraphElement>(null),
    next: useRef<HTMLParagraphElement>(null),
    next2: useRef<HTMLParagraphElement>(null),
  };
  const clock = useRef(createSyncClock());
  const view = useRef<ReturnType<typeof createLyricsView> | null>(null);
  const shownFor = useRef<number | null>(null); // the song whose lyrics are on screen

  const { current } = state ? splitQueue(state) : { current: null };
  const next = state ? nextUp(state) : null;
  const { upcoming } = state ? playOrder(state) : { upcoming: [] };
  const currentId = current?.id ?? null;

  useEffect(() => {
    view.current = createLyricsView({
      prev: refs.prev.current!,
      current: refs.current.current!,
      next: refs.next.current!,
      next2: refs.next2.current!,
    });
    let frame = 0;
    const paint = () => {
      view.current?.render(clock.current.time());
      frame = requestAnimationFrame(paint);
    };
    frame = requestAnimationFrame(paint);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // a new song: clears the lyrics and the clock
  useEffect(() => {
    if (shownFor.current === currentId) return;
    shownFor.current = currentId;
    view.current?.setCues([]);
    clock.current.reset();
    if (state) clock.current.position(state.position_ms);
  }, [currentId, state]);

  // the progress: playing or paused, the lyrics adjustment and the duet
  useEffect(() => {
    clock.current.setPlaying(Boolean(current) && state?.playback === 'playing');
    view.current?.setOffset(current?.lyric_offset ?? 0);
    view.current?.setDuet(current?.guest?.status === 'accepted', current?.parts);
  }, [current, state?.playback]);

  // the position the TV reports every second
  useEffect(() => {
    if (currentId !== null && position.itemId === currentId) clock.current.position(position.ms);
  }, [position, currentId]);

  // the lyrics: relayed by the TV; with the song on the server (or in the cloud) they can also be fetched directly
  useEffect(() => {
    if (lyrics && lyrics.itemId === currentId) view.current?.setCues(lyrics.cues);
  }, [lyrics, currentId]);
  const lyricsUrl = current?.song.media?.local ? null : current?.song.media?.lyrics;
  useEffect(() => {
    if (!lyricsUrl) return undefined;
    let cancelled = false;
    void fetch(lyricsUrl)
      .then((res) => (res.ok ? res.json() : null))
      .then((cues) => {
        if (!cancelled && Array.isArray(cues) && !view.current?.cues.length) view.current?.setCues(cues);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [lyricsUrl]);

  return (
    <section className="tv-viewer" aria-label={t('tvview.aria')}>
      {!state?.tv_connected && <p className="hint tv-viewer-note">{t('tvview.noTv')}</p>}
      <LyricsSize />
      {state && <InterludeBanner state={state} controls={false} />}
      <header className="tv-viewer-top">
        {current ? (
          <div className="singer is-now">
            <span className="label">{t('tv.singingNow')}</span>
            <strong className="who">
              <SingerBlobs item={current} />
              <span className="who-name">{current.singers}</span>
            </strong>
            <span className="what">{[titleOf(current), current.artist].filter(Boolean).join(' — ')}</span>
            <span className="key">{keySummary(current.song.key, current.pitch)}</span>
          </div>
        ) : (
          <p className="hint">{t('tvview.nothing')}</p>
        )}
        {next && (
          <div className="singer is-next">
            <span className="label">{t('tv.next')}</span>
            <strong className="who">
              <SingerBlobs item={next.item} />
              <span className="who-name">{next.item.singers}</span>
            </strong>
            <span className="what">{titleOf(next.item)}</span>
          </div>
        )}
      </header>

      <div className="lyrics stage-lyrics" aria-live="off" hidden={!current}>
        <p className="line prev" ref={refs.prev} />
        <p className="line current" ref={refs.current} />
        <p className="line next" ref={refs.next} />
        <p className="line next2" ref={refs.next2} />
      </div>

      <ReactionBar onReact={react} />
      <QueueBox current={current} upcoming={upcoming} />
    </section>
  );
}
