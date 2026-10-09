// TV: toca o que a sala manda, mostra a letra sincronizada, quem canta, a fila e a pontuação.
import { useCallback, useEffect, useRef, useState } from 'react';
import { keySummary } from '../lib/music.js';
import { nextUp, playOrder, songChip, splitQueue } from '../lib/queue-view.js';
import type { QueueItem, RoomState } from '../lib/types';
import { Icon } from '../ui/Icon';
import { createTvController, type FinalResult, type HudState, type TvController } from './controller';
import { QrCode } from './QrCode';

const UPCOMING_SHOWN = 5;
const trackName = (item: QueueItem) => [item.title ?? item.video_id, item.artist].filter(Boolean).join(' — ');
const titleOf = (item: QueueItem) => item.title ?? item.video_id;

declare global {
  interface Window {
    tv?: { engine: TvController['engine']; readonly state: RoomState | null };
  }
}

function QueueRow({ item, badge, isCurrent = false }: { item: QueueItem; badge: string; isCurrent?: boolean }) {
  return (
    <li className={isCurrent ? 'is-current' : ''}>
      <span className="mark">{badge}</span>
      <span className="text">
        <strong>{item.added_by}</strong>
        <small>
          {titleOf(item)}
          {item.song.ready ? '' : ` · ${songChip(item.song).label.toLowerCase()}`}
        </small>
      </span>
    </li>
  );
}

/** Lista lateral: a música atual e as próximas 5, na ordem em que vão tocar (para ceder a vez com conhecimento de causa). */
function QueueBox({ current, upcoming }: { current: QueueItem | null; upcoming: QueueItem[] }) {
  return (
    <aside className="tv-queue" hidden={!current && !upcoming.length} aria-label="Fila de cantores">
      <h2>Fila</h2>
      <ol>
        {current && <QueueRow item={current} badge="▶" isCurrent />}
        {upcoming.slice(0, UPCOMING_SHOWN).map((item, i) => (
          <QueueRow key={item.id} item={item} badge={String(i + 1)} />
        ))}
        {upcoming.length > UPCOMING_SHOWN && <li className="more">+ {upcoming.length - UPCOMING_SHOWN} na fila</li>}
      </ol>
    </aside>
  );
}

function ScoreHud({ hud }: { hud: HudState }) {
  return (
    <aside className="score-hud" hidden={!hud.visible} aria-live="off">
      <span className="label">Pontuação</span>
      <strong>{hud.score}</strong>
      <small>
        {hud.notice ||
          (hud.original && (
            <>
              Original: <b>{hud.original}</b>
              <br />
              Você: <b>{hud.sung}</b>
            </>
          ))}
      </small>
    </aside>
  );
}

function ScoreFinal({ final, room }: { final: FinalResult | null; room: RoomState | null }) {
  return (
    <section className="score-final" hidden={!final} role="status">
      <span className="label">Pontuação final</span>
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- as refs são estáveis
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
  const nextLabel = next ? `${titleOf(next.item)}${next.preparing ? ' (preparando…)' : ''}` : '';

  return (
    <main className={`tv-stage${hasQueue ? ' has-queue' : ''}`} ref={stageRef}>
      <header className="tv-top">
        <div className="singer is-now" hidden={!current}>
          {current && (
            <>
              <span className="label">Cantando agora</span>
              <strong className="who">
                <Icon name="singing" /> {current.added_by}
              </strong>
              <span className="what">{trackName(current)}</span>
              <span className="key">{keySummary(current.song.key, current.pitch)}</span>
            </>
          )}
        </div>
        <div className="singer is-next" hidden={!next}>
          {next && (
            <>
              <span className="label">Próximo</span>
              <strong className="who">
                <Icon name="singing" /> {next.item.added_by}
              </strong>
              <span className="what">{nextLabel}</span>
            </>
          )}
        </div>
        <div className="tv-meta">
          <span className="room-tag">
            Sala <strong>{code}</strong>
          </span>
          <button type="button" title="Tela cheia (F)" aria-label="Tela cheia" onClick={toggleFullscreen}>
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
        </section>
        <ScoreHud hud={hud} />
        <QueueBox current={current} upcoming={upcoming} />
      </div>

      <footer className="tv-bottom">
        <div className="tv-progress" aria-hidden="true">
          <div style={{ width: `${progress}%` }} />
        </div>
        <p className="hint" role="status">
          {notice}
        </p>
      </footer>

      <section className="idle" hidden={Boolean(current)}>
        <h1>
          <Icon name="singing" />
          Singalong
        </h1>
        <p className="idle-lead">
          Entre na sala <strong>{code}</strong> pelo celular
        </p>
        <QrCode code={code} />
        <p className="idle-msg">
          {next ? `Próximo: ${next.item.added_by} — ${nextLabel}` : 'Adicione músicas pelo celular para começar.'}
        </p>
      </section>

      <ScoreFinal final={final} room={room} />

      <button
        type="button"
        className="unlock"
        hidden={!unlockVisible}
        onClick={() => void controllerRef.current?.unlock()}
      >
        Toque aqui para ativar o som
      </button>
    </main>
  );
}
