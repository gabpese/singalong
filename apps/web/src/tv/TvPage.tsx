// TV: toca o que a sala manda, mostra a letra sincronizada, quem canta, a fila e a pontuação.
import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../i18n/index.js';
import { tRich } from '../i18n/rich';
import { accessMessage, localMediaBase, probeLocalMedia } from '../lib/local-media.js';
import { keySummary } from '../lib/music.js';
import { nextUp, playOrder, splitQueue } from '../lib/queue-view.js';
import type { QueueItem, RoomState } from '../lib/types';
import { Icon } from '../ui/Icon';
import { InviteNotice, respondInvite } from '../room/Duet';
import { createTvController, type FinalResult, type HudState, type TvController } from './controller';
import { QrCode } from './QrCode';
import { QueueBox, titleOf } from './QueueBox';

const trackName = (item: QueueItem) => [item.title ?? item.video_id, item.artist].filter(Boolean).join(' — ');

declare global {
  interface Window {
    tv?: { engine: TvController['engine']; readonly state: RoomState | null };
  }
}

/** O QR code da sala sempre à vista (quem chega no meio da festa entra sem pedir o código): fica abaixo da fila enquanto toca. */
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
      <span className="label">{t('tvp.score')}</span>
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
      <span className="label">{t('tvp.finalScore')}</span>
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
 * Músicas no computador do dono: confere se esta página alcança o servidor local de mídia (isso também provoca o aviso de
 * "Acesso à rede local" do Chrome/Edge) e devolve o texto que explica o que fazer, ou '' se está tudo certo.
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

/** Dueto: quem canta em cada cor (verde, vermelho e amarelo quando os dois cantam). */
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
    // as linhas da letra pertencem ao motor de áudio (ele desenha cada palavra com o seu preenchimento): o React só as entrega
    const controller = createTvController(
      code,
      { setRoom, notify: setNotice, setUnlock: setUnlockVisible, setHud, setProgress, setFinal },
      {
        prev: lyricsRefs.prev.current!,
        current: lyricsRefs.current.current!,
        next: lyricsRefs.next.current!,
        next2: lyricsRefs.next2.current!,
      },
    );
    controllerRef.current = controller;
    // gancho de diagnóstico (testes no navegador)
    window.tv = { engine: controller.engine, get state() { return controller.state; } };
    return () => controller.stop();
  }, [code]);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void stageRef.current?.requestFullscreen?.();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.key === 'f' || event.key === 'F') && !event.ctrlKey && !event.metaKey && !event.altKey) toggleFullscreen();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [toggleFullscreen]);

  const { current } = room ? splitQueue(room) : { current: null as QueueItem | null };
  const next = room ? nextUp(room) : null;
  const { upcoming } = room ? playOrder(room) : { upcoming: [] as QueueItem[] };
  const hasQueue = Boolean(current) || upcoming.length > 0;
  const nextLabel = next ? `${titleOf(next.item)}${next.preparing ? ` ${t('next.preparing')}` : ''}` : '';

  return (
    <main className={`tv-stage${hasQueue ? ' has-queue' : ''}`} ref={stageRef}>
      <div className="tv-invites">
        <InviteNotice state={room} onRespond={(item, accept) => void respondInvite(code, item, accept)} />
      </div>
      <header className="tv-top">
        <div className="singer is-now" hidden={!current}>
          {current && (
            <>
              <span className="label">{t('tv.singingNow')}</span>
              <strong className="who">
                <Icon name="singing" /> {current.singers}
              </strong>
              <span className="what">{trackName(current)}</span>
              <span className="key">{keySummary(current.song.key, current.pitch)}</span>
            </>
          )}
        </div>
        <div className="singer is-next" hidden={!next}>
          {next && (
            <>
              <span className="label">{t('tv.next')}</span>
              <strong className="who">
                <Icon name="singing" /> {next.item.singers}
              </strong>
              <span className="what">{nextLabel}</span>
            </>
          )}
        </div>
        <div className="tv-meta">
          <span className="room-tag">
            Sala <strong>{code}</strong>
          </span>
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
        <ScoreHud hud={hud} />
        <div className="tv-side">
          <QueueBox current={current} upcoming={upcoming} />
          {current && <JoinCard code={code} />}
        </div>
      </div>

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
        <h1>
          <Icon name="singing" />
          Singalong
        </h1>
        <p className="idle-lead">
          {tRich('tvp.idleLead', { code })}
        </p>
        <QrCode code={code} />
        <p className="idle-msg">
          {next ? t('tvp.idleNext', { who: next.item.singers, title: nextLabel }) : t('tvp.idleAdd')}
        </p>
      </section>

      <ScoreFinal final={final} room={room} />

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
