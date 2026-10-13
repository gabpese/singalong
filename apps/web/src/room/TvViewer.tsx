// Aba TV da sala: quem está no celular acompanha a letra, quem canta e a fila. Só assiste: o som e o microfone são do aparelho
// que abriu a TV como player (tv.html), então dois aparelhos nunca tocam a mesma música.
import { useEffect, useRef } from 'react';
import { t } from '../i18n/index.js';
import { createSyncClock } from '../lib/clock.js';
import { keySummary } from '../lib/music.js';
import { createLyricsView } from '../lib/lyrics-view.js';
import { nextUp, playOrder, splitQueue } from '../lib/queue-view.js';
import type { LyricCue, RoomState } from '../lib/types';
import { Icon } from '../ui/Icon';
import { LyricsSize } from '../ui/LyricsSize';
import { QueueBox, titleOf } from '../tv/QueueBox';
import type { Position } from './useRoomConnection';

interface Props {
  state: RoomState | null;
  position: Position;
  lyrics: { itemId: number; cues: LyricCue[] } | null;
}

export function TvViewer({ state, position, lyrics }: Props) {
  const refs = {
    prev: useRef<HTMLParagraphElement>(null),
    current: useRef<HTMLParagraphElement>(null),
    next: useRef<HTMLParagraphElement>(null),
    next2: useRef<HTMLParagraphElement>(null),
  };
  const clock = useRef(createSyncClock());
  const view = useRef<ReturnType<typeof createLyricsView> | null>(null);
  const shownFor = useRef<number | null>(null); // a música cuja letra está na tela

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

  // música nova: limpa a letra e o relógio
  useEffect(() => {
    if (shownFor.current === currentId) return;
    shownFor.current = currentId;
    view.current?.setCues([]);
    clock.current.reset();
    if (state) clock.current.position(state.position_ms);
  }, [currentId, state]);

  // andamento: tocando ou em pausa, ajuste da letra e dueto
  useEffect(() => {
    clock.current.setPlaying(Boolean(current) && state?.playback === 'playing');
    view.current?.setOffset(current?.lyric_offset ?? 0);
    view.current?.setDuet(current?.guest?.status === 'accepted');
  }, [current, state?.playback]);

  // a posição que a TV informa a cada segundo
  useEffect(() => {
    if (currentId !== null && position.itemId === currentId) clock.current.position(position.ms);
  }, [position, currentId]);

  // a letra: repassada pela TV; com a música no servidor (ou na nuvem) também dá para buscar direto
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
      <header className="tv-viewer-top">
        {current ? (
          <div className="singer is-now">
            <span className="label">{t('tv.singingNow')}</span>
            <strong className="who">
              <Icon name="singing" /> {current.singers}
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
              <Icon name="singing" /> {next.item.singers}
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

      <QueueBox current={current} upcoming={upcoming} />
    </section>
  );
}
