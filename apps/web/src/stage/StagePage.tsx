// Palco: a tela de canto do celular. Mostra a letra no ritmo da TV (que toca a música) e devolve o cantor à sala quando acaba.
import { useCallback, useEffect, useRef, useState } from 'react';
import { createSyncClock } from '../lib/clock.js';
import { myPart, PART_NAMES } from '../lib/duet.js';
import { connectRoom } from '../lib/identity.js';
import { createLyricsView } from '../lib/lyrics-view.js';
import { splitQueue } from '../lib/queue-view.js';
import { InviteDialog, InviteNotice, respondInvite } from '../room/Duet';
import { api } from '../lib/identity.js';
import { dismissStage, STAGE_END_SECONDS, stageItemFor } from '../lib/stage.js';
import type { LyricCue, QueueItem, RoomState, ServerMessage } from '../lib/types';

const roomUrl = (code: string) => `/room.html?room=${code}`;

interface Ended {
  title: string;
  score: number | null;
}

export function StagePage({ code }: { code: string }) {
  const [state, setState] = useState<RoomState | null>(null);
  const [ended, setEnded] = useState<Ended | null>(null);
  const [item, setItem] = useState<QueueItem | null>(null); // a música no palco (para o título na tela)
  const [choosing, setChoosing] = useState(false); // escolhendo quem convidar para cantar junto
  const [status, setStatus] = useState<'connecting' | 'connected' | 'reconnecting'>('connecting');
  const lyricsRefs = {
    prev: useRef<HTMLParagraphElement>(null),
    current: useRef<HTMLParagraphElement>(null),
    next: useRef<HTMLParagraphElement>(null),
    next2: useRef<HTMLParagraphElement>(null),
  };
  const clock = useRef(createSyncClock());
  const view = useRef<ReturnType<typeof createLyricsView> | null>(null);
  const itemRef = useRef<number | null>(null); // a música que trouxe o cantor até aqui
  const itemInfo = useRef<QueueItem | null>(null);
  const pendingLyrics = useRef<{ itemId: number; cues: LyricCue[] } | null>(null); // a letra pode chegar antes do estado da sala

  const leave = useCallback(() => {
    if (itemRef.current !== null) dismissStage(code, itemRef.current);
    location.replace(roomUrl(code));
  }, [code]);

  useEffect(() => {
    document.title = `Singalong — Palco ${code}`;
    view.current = createLyricsView({
      prev: lyricsRefs.prev.current!,
      current: lyricsRefs.current.current!,
      next: lyricsRefs.next.current!,
      next2: lyricsRefs.next2.current!,
    });
    let frame = 0;
    const paint = () => {
      view.current?.render(clock.current.time());
      frame = requestAnimationFrame(paint);
    };
    frame = requestAnimationFrame(paint);

    const connection = connectRoom(code, 'controller', {
      onMessage(message: ServerMessage) {
        if (message.type === 'state') {
          setState(message.state);
        } else if (message.type === 'position' && message.item_id === itemRef.current) {
          clock.current.position(message.ms);
        } else if (message.type === 'lyrics') {
          pendingLyrics.current = { itemId: message.item_id, cues: message.cues };
          if (message.item_id === itemRef.current) view.current?.setCues(message.cues);
        }
      },
      onStatus: (next: string) => setStatus(next === 'connected' ? 'connected' : 'reconnecting'),
      onGone: () => location.replace('/'),
    });
    return () => {
      cancelAnimationFrame(frame);
      connection.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  // o estado da sala manda: quem está no palco, se a música acabou e se está tocando ou em pausa
  useEffect(() => {
    if (!state) return;
    const mine = stageItemFor(state);
    const current = splitQueue(state).current;
    if (itemRef.current === null) {
      if (mine === null) {
        location.replace(roomUrl(code)); // não é a vez deste cantor: volta para a sala
        return;
      }
      itemRef.current = mine;
      itemInfo.current = current;
      setItem(current);
      view.current?.setDuet(current?.guest?.status === 'accepted');
      clock.current.reset();
      clock.current.position(state.position_ms);
      const waiting = pendingLyrics.current;
      if (waiting && waiting.itemId === mine) view.current?.setCues(waiting.cues); // a letra que a TV já mandou
    }
    if (state.current_item_id === itemRef.current) {
      itemInfo.current = current ?? itemInfo.current;
      if (current) setItem(current); // título, cantor e ajuste da letra sempre atuais
      view.current?.setDuet(current?.guest?.status === 'accepted'); // dueto: a letra ganha as duas cores
      clock.current.setPlaying(state.playback === 'playing');
      view.current?.setOffset(current?.lyric_offset ?? 0);
      // com a música no servidor (ou na nuvem) a letra vem direto; no computador do dono só a TV a alcança e a repassa pelo servidor
      const lyricsUrl = current?.song.media?.lyrics;
      if (lyricsUrl && !current?.song.media?.local && !view.current?.cues.length) {
        const wanted = current?.id;
        void fetch(lyricsUrl)
          .then((res) => (res.ok ? res.json() : null))
          .then((cues) => {
            if (Array.isArray(cues) && itemRef.current === wanted && !view.current?.cues.length) view.current?.setCues(cues);
          })
          .catch(() => undefined);
      }
    } else if (!ended) {
      // a música acabou (ou o anfitrião pulou): mostra o fim e devolve o cantor à sala
      const score = state.scoring ? state.scoreboard.find((entry) => entry.id === itemRef.current)?.score ?? null : null;
      setEnded({ title: itemInfo.current?.title ?? 'Sua música', score });
    } else if (state.scoring && ended.score === null) {
      // a nota pode chegar um instante depois do fim
      const score = state.scoreboard.find((entry) => entry.id === itemRef.current)?.score ?? null;
      if (score !== null) setEnded({ ...ended, score });
    }
  }, [state, code, ended]);

  useEffect(() => {
    if (!ended) return undefined;
    const timer = setTimeout(() => location.replace(roomUrl(code)), STAGE_END_SECONDS * 1000);
    return () => clearTimeout(timer);
  }, [ended, code]);

  const current = item;
  const paused = state?.playback === 'paused';
  return (
    <main className="stage-page">
      <header className="stage-top">
        <div>
          <p className="stage-where">Palco · Sala {code}</p>
          <h1 className="stage-song">{current?.title ?? '…'}</h1>
          <p className="stage-artist">
            {current?.artist ?? ''}
            {current?.singers ? ` — ${current.singers}` : ''}
          </p>
        </div>
        <button type="button" onClick={leave}>
          Voltar à sala
        </button>
      </header>

      <InviteNotice state={state} onRespond={(invited, accept) => void respondInvite(code, invited, accept)} />

      {/* quem canta pode chamar alguém da sala para cantar junto, mesmo com a música já tocando */}
      {item?.mine && (
        <div className="stage-duet">
          {item.guest?.status === 'pending' && <span className="duet-note">{`Convite enviado para ${item.guest.name}, aguardando…`}</span>}
          {item.guest?.status === 'accepted' && <span className="duet-note ok">{`Dueto com ${item.guest.name} ✓`}</span>}
          {item.guest ? (
            <button type="button" className="ghost" onClick={() => void api('DELETE', `/api/rooms/${code}/queue/${item.id}/invite`, undefined, code).catch(() => undefined)}>
              {item.guest.status === 'accepted' ? 'Tirar o dueto' : 'Cancelar o convite'}
            </button>
          ) : (
            <button type="button" className="ghost" onClick={() => setChoosing(true)}>
              Convidar para cantar junto
            </button>
          )}
        </div>
      )}
      {choosing && item && (
        <InviteDialog
          people={state?.people ?? []}
          mePid={state?.me.pid ?? null}
          onClose={() => setChoosing(false)}
          onInvite={async (person) => {
            await api('POST', `/api/rooms/${code}/queue/${item.id}/invite`, { pid: person.pid }, code);
          }}
        />
      )}

      <section className="lyrics stage-lyrics" aria-live="off">
        <p className="line prev" ref={lyricsRefs.prev} />
        <p className="line current" ref={lyricsRefs.current} />
        <p className="line next" ref={lyricsRefs.next} />
        <p className="line next2" ref={lyricsRefs.next2} />
      </section>

      {item?.guest?.status === 'accepted' && (
        <p className="duet-legend stage-legend" aria-label="Cores do dueto">
          <span data-part={myPart(item)}>{`Você canta nas partes ${PART_NAMES[myPart(item)]}`}</span>
          <span data-part={myPart(item) === 'a' ? 'b' : 'a'}>{item.mine ? item.guest.name : item.added_by}</span>
          <span data-part="both">os dois</span>
        </p>
      )}

      <footer className="stage-bottom" role="status">
        {ended ? (
          <div className="stage-end">
            <strong>Acabou! 👏</strong>
            {ended.score !== null ? <span>Sua nota: {ended.score}</span> : null}
            <small>Voltando para a sala…</small>
          </div>
        ) : status === 'reconnecting' ? (
          'Reconectando à sala…'
        ) : state && !state.tv_connected ? (
          'A TV não está conectada.'
        ) : paused ? (
          'Em pausa'
        ) : (
          ''
        )}
      </footer>
    </main>
  );
}
