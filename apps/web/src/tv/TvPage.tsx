// TV: plays what the Room sends, shows the synced lyrics, who is singing, the Queue and the Score.
import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../i18n/index.ts';
import { changeLyricsScale } from '../lib/accessibility.ts';
import { LyricsSize } from '../ui/LyricsSize';
import { ReactionLayer, useReactionLayer } from '../ui/ReactionLayer';
import { tRich } from '../i18n/rich';
import { accessMessage, localMediaBase, probeLocalMedia } from '../lib/local-media.ts';
import { keySummary } from '../lib/music.ts';
import { nextUp, playOrder, splitQueue } from '../lib/queue-view.ts';
import type { QueueItem, RoomState } from '../lib/types.ts';
import { SingerBlobs } from '../ui/SingerBlobs';
import { InviteNotice, respondInvite } from '../room/Duet';
import { createTvController, type FinalResult, type HudState, type TvController } from './controller';
import { LatencyDialog } from './LatencyDialog';
import { MicsDialog } from './MicsDialog';
import { PitchGuide } from './PitchGuide';
import { BetaTag } from '../ui/BetaTag';
import { Interlude } from './Interlude';
import { Lobby } from './Lobby';
import { QrCode } from './QrCode';
import { QueueBox, titleOf } from './QueueBox';

const trackName = (item: QueueItem) => [item.title ?? item.video_id, item.artist].filter(Boolean).join(' — ');

declare global {
  interface Window {
    tv?: { engine: TvController['engine']; readonly state: RoomState | null };
  }
}

/** The Room's QR code always in view (whoever arrives in the middle of the party joins without asking for the code): it sits beside whoever is singing. */
function JoinCard({ code }: { code: string }) {
  return (
    <aside className="tv-join" aria-label={t('tvp.joinAria')}>
      <QrCode code={code} compact />
      <p>{tRich('tvp.joinText', { code })}</p>
    </aside>
  );
}

function ScoreHud({ hud }: { hud: HudState }) {
  return (
    <aside className="score-hud" hidden={!hud.visible} aria-live="off">
      <span className="label">
        {t('tvp.score')} <BetaTag />
      </span>
      <strong>{hud.score}</strong>
      <small>
        {hud.notice ||
          (hud.original && (
            <>
              {tRich('tvp.original', { note: hud.original })}
              <br />
              {tRich('tvp.you', { note: hud.sung })}
            </>
          ))}
      </small>
    </aside>
  );
}

function ScoreFinal({ final, room }: { final: FinalResult | null; room: RoomState | null }) {
  return (
    <section className="score-final" hidden={!final} role="status">
      <span className="label">
        {t('tvp.finalScore')} <BetaTag />
      </span>
      <strong>{final?.score}</strong>
      <span>{final?.singer}</span>
      <small>{final?.message}</small>
      <ol>
        {(room?.scoreboard ?? []).slice(0, 3).map((row) => (
          <li key={row.id}>
            {row.name} — {row.score}
          </li>
        ))}
      </ol>
    </section>
  );
}

/**
 * Songs on the Owner's computer: checks whether this page reaches the local media server (which also triggers Chrome/Edge's
 * "Local network access" prompt) and returns the text that explains what to do, or '' if all is well.
 */
function useLocalMediaNotice(room: RoomState | null): string {
  const base = localMediaBase(room);
  const [status, setStatus] = useState<'idle' | 'checking' | 'ok' | 'blocked'>('idle');
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!base) {
      setStatus('idle');
      return undefined;
    }
    let cancelled = false;
    const started = Date.now();
    setStatus('checking');
    setElapsed(0);
    const tick = setInterval(() => setElapsed(Date.now() - started), 500);
    void probeLocalMedia(base)
      .then((ok: boolean) => {
        if (!cancelled) setStatus(ok ? 'ok' : 'blocked');
      })
      .finally(() => clearInterval(tick));
    return () => {
      cancelled = true;
      clearInterval(tick);
    };
  }, [base]);
  return accessMessage(status, elapsed);
}

/** Duet: who sings in each color (turquoise, violet, and yellow when both sing). */
function DuetLegend({ first, second }: { first: string; second: string }) {
  return (
    <p className="duet-legend" aria-label={t('tvp.duetAria')}>
      <span data-part="a">{first}</span>
      <span data-part="b">{second}</span>
      <span data-part="both">{t('tvp.both')}</span>
    </p>
  );
}

export function TvPage({ code }: { code: string }) {
  const [room, setRoom] = useState<RoomState | null>(null);
  const [notice, setNotice] = useState('');
  const [unlockVisible, setUnlockVisible] = useState(false);
  const [hud, setHud] = useState<HudState>({ visible: false, score: 0, notice: '', original: '', sung: '' });
  const [progress, setProgress] = useState(0);
  const [final, setFinal] = useState<FinalResult | null>(null);
  const [calibrating, setCalibrating] = useState(false);
  const [choosingMics, setChoosingMics] = useState(false);
  const reactions = useReactionLayer();
  const [guideReady, setGuideReady] = useState(false); // the melody guide has notes to draw

  const stageRef = useRef<HTMLElement>(null);
  const lyricsRefs = {
    prev: useRef<HTMLParagraphElement>(null),
    current: useRef<HTMLParagraphElement>(null),
    next: useRef<HTMLParagraphElement>(null),
    next2: useRef<HTMLParagraphElement>(null),
  };
  const controllerRef = useRef<TvController | null>(null);
  const localMediaNotice = useLocalMediaNotice(room);

  useEffect(() => {
    document.title = `Singalong — TV ${code}`;
    // the lyrics' lines belong to the audio engine (it draws each word with its fill): React only hands them over
    const controller = createTvController(
      code,
      { setRoom, notify: setNotice, setUnlock: setUnlockVisible, setHud, setProgress, setFinal, addReaction: reactions.push, setGuideReady },
      {
        prev: lyricsRefs.prev.current!,
        current: lyricsRefs.current.current!,
        next: lyricsRefs.next.current!,
        next2: lyricsRefs.next2.current!,
      },
    );
    controllerRef.current = controller;
    // a diagnostics hook (the browser tests)
    window.tv = { engine: controller.engine, get state() { return controller.state; } };
    return () => controller.stop();
  }, [code]);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void stageRef.current?.requestFullscreen?.();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === 'f' || event.key === 'F') toggleFullscreen();
      else if (event.key === 'l' || event.key === 'L') setCalibrating(true);
      else if (event.key === 'm' || event.key === 'M') setChoosingMics(true);
      else if (event.key === '+' || event.key === '=') changeLyricsScale(1);
      else if (event.key === '-') changeLyricsScale(-1);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [toggleFullscreen]);

  const { current } = room ? splitQueue(room) : { current: null as QueueItem | null };
  const next = room ? nextUp(room) : null;
  const { upcoming } = room ? playOrder(room) : { upcoming: [] as QueueItem[] };
  const hasQueue = Boolean(current) || upcoming.length > 0;
  const showGuide = Boolean(room?.melody_bars) && guideReady && Boolean(current);
  const showLower = showGuide || hud.visible; // the bottom strip: the melody guide and the Score (it never floats over the rest)
  const nextLabel = next ? `${titleOf(next.item)}${next.preparing ? ` ${t('next.preparing')}` : ''}` : '';

  return (
    <main className={`tv-stage${hasQueue ? ' has-queue' : ''}${showGuide ? ' has-guide' : ''}${showLower ? ' has-lower' : ''}`} ref={stageRef}>
      <div className="tv-invites">
        <InviteNotice state={room} onRespond={(item, accept) => void respondInvite(code, item, accept)} />
      </div>
      <header className="tv-top">
        <div className="tv-now">
          {current && <JoinCard code={code} />}
          <div className="singer is-now" hidden={!current}>
            {current && (
              <>
                <span className="label">{t('tv.singingNow')}</span>
                <strong className="who">
                  <SingerBlobs item={current} animate />
                  <span className="who-name">{current.singers}</span>
                </strong>
                <span className="what">{trackName(current)}</span>
                <span className="key">{keySummary(current.song.key, current.pitch)}</span>
              </>
            )}
          </div>
        </div>
        <div className="singer is-next" hidden={!next}>
          {next && (
            <>
              <span className="label">{t('tv.next')}</span>
              <strong className="who">
                <SingerBlobs item={next.item} />
                <span className="who-name">{next.item.singers}</span>
              </strong>
              <span className="what">{nextLabel}</span>
            </>
          )}
        </div>
        <div className="tv-meta">
          <span className="room-tag">
            {t('room.word')} <strong>{code}</strong>
          </span>
          <LyricsSize />
          <button type="button" title={t('mics.buttonTip')} onClick={() => setChoosingMics(true)}>
            {t('mics.button')}
          </button>
          <button type="button" title={t('lat.buttonTip')} onClick={() => setCalibrating(true)}>
            {t('lat.button')}
          </button>
          <button type="button" title={t('tvp.fullscreenTip')} aria-label={t('tvp.fullscreen')} onClick={toggleFullscreen}>
            ⛶
          </button>
        </div>
      </header>

      <div className="tv-body">
        <section className="lyrics" aria-live="off">
          <p className="line prev" ref={lyricsRefs.prev} />
          <p className="line current" ref={lyricsRefs.current} />
          <p className="line next" ref={lyricsRefs.next} />
          <p className="line next2" ref={lyricsRefs.next2} />
          {current?.guest?.status === 'accepted' && <DuetLegend first={current.added_by} second={current.guest.name} />}
        </section>
        <div className="tv-side">
          <QueueBox current={current} upcoming={upcoming} />
        </div>
      </div>

      {showLower && (
        <div className="tv-lower">
          {showGuide && (
            <div className="guide-card">
              <PitchGuide controller={controllerRef.current} />
              <BetaTag />
            </div>
          )}
          <ScoreHud hud={hud} />
        </div>
      )}

      <footer className="tv-bottom">
        <div className="tv-progress" aria-hidden="true">
          <div style={{ width: `${progress}%` }} />
        </div>
        <p className="hint" role="status">
          {notice}
        </p>
        <p className="hint local-media" role="alert" hidden={!localMediaNotice}>
          {localMediaNotice}
        </p>
      </footer>

      <section className="idle" hidden={Boolean(current)}>
        <Lobby code={code} people={room?.people ?? []} status={next ? t('tvp.idleNext', { who: next.item.singers, title: nextLabel }) : t('tvp.idleAdd')} />
      </section>

      {/* the Intermission covers everything (the waiting too): Applause for whoever sang, then Taking the stage for whoever is next */}
      <Interlude room={room} />

      {/* during the Applause the Score already shows in the middle of the screen: the final-score board does not repeat it */}
      <ScoreFinal final={room?.interlude ? null : final} room={room} />
      <ReactionLayer items={reactions.items} />
      {choosingMics && <MicsDialog controller={controllerRef.current} onClose={() => setChoosingMics(false)} />}
      {calibrating && <LatencyDialog controller={controllerRef.current} onClose={() => setCalibrating(false)} />}

      <button
        type="button"
        className="unlock"
        hidden={!unlockVisible}
        onClick={() => void controllerRef.current?.unlock()}
      >
        {t('tvp.unlock')}
      </button>
    </main>
  );
}
