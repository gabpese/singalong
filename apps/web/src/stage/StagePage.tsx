// Stage: the phone's singing screen. It shows the lyrics in time with the TV (which plays the song) and sends the singer back to the Room when it ends.
import { useCallback, useEffect, useRef, useState } from 'react';
import { t } from '../i18n/index.ts';
import { BetaTag } from '../ui/BetaTag';
import { LyricsSize } from '../ui/LyricsSize';
import { ReactionLayer, useReactionLayer } from '../ui/ReactionLayer';
import { createSyncClock } from '../lib/clock.ts';
import { myPart, partName } from '../lib/duet.ts';
import { connectRoom } from '../lib/identity.ts';
import { createLyricsView } from '../lib/lyrics-view.ts';
import { splitQueue } from '../lib/queue-view.ts';
import { useInterlude } from '../ui/useInterlude';
import { InviteDialog, InviteNotice, respondInvite } from '../room/Duet';
import { api } from '../lib/identity.ts';
import { dismissStage, STAGE_END_SECONDS, stageItemFor } from '../lib/stage.ts';
import type { LyricCue, QueueItem, RoomState, ServerMessage } from '../lib/types.ts';

const roomUrl = (code: string) => `/room.html?room=${code}`;

interface Ended {
  title: string;
  score: number | null;
}

/** Taking the stage on the phone of whoever is about to sing: the call and how long until the song starts. */
function StageCall({ state }: { state: RoomState }) {
  const clock = useInterlude(state.interlude);
  if (!clock) return null;
  return (
    <div className="stage-call" role="status">
      <strong>{t('interlude.yourTurn')}</strong>
      <span>{t('interlude.startsIn.long', { n: clock.seconds })}</span>
    </div>
  );
}

export function StagePage({ code }: { code: string }) {
  const [state, setState] = useState<RoomState | null>(null);
  const [ended, setEnded] = useState<Ended | null>(null);
  const [item, setItem] = useState<QueueItem | null>(null); // the song on the Stage (for the title on screen)
  const [choosing, setChoosing] = useState(false); // choosing whom to invite to sing along
  const [status, setStatus] = useState<'connecting' | 'connected' | 'reconnecting'>('connecting');
  const lyricsRefs = {
    prev: useRef<HTMLParagraphElement>(null),
    current: useRef<HTMLParagraphElement>(null),
    next: useRef<HTMLParagraphElement>(null),
    next2: useRef<HTMLParagraphElement>(null),
  };
  const reactions = useReactionLayer();
  const reactionsRef = useRef(reactions.push);
  reactionsRef.current = reactions.push;
  const clock = useRef(createSyncClock());
  const view = useRef<ReturnType<typeof createLyricsView> | null>(null);
  const itemRef = useRef<number | null>(null); // the song that brought the singer here
  const itemInfo = useRef<QueueItem | null>(null);
  const pendingLyrics = useRef<{ itemId: number; cues: LyricCue[] } | null>(null); // the lyrics can arrive before the Room's state

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
        } else if (message.type === 'reaction') {
          reactionsRef.current(message.kind, message.name);
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

  // the Room's state rules: who is on the Stage, whether the song ended and whether it is playing or paused
  useEffect(() => {
    if (!state) return;
    const mine = stageItemFor(state);
    const current = splitQueue(state).current;
    if (itemRef.current === null) {
      if (mine === null) {
        location.replace(roomUrl(code)); // it is not this singer's turn: back to the Room
        return;
      }
      itemRef.current = mine;
      itemInfo.current = current;
      setItem(current);
      view.current?.setDuet(current?.guest?.status === 'accepted', current?.parts);
      clock.current.reset();
      clock.current.position(state.position_ms);
      const waiting = pendingLyrics.current;
      if (waiting && waiting.itemId === mine) view.current?.setCues(waiting.cues); // the lyrics the TV already sent
    }
    if (state.current_item_id === itemRef.current) {
      itemInfo.current = current ?? itemInfo.current;
      if (current) setItem(current); // the title, the singer and the lyrics adjustment always current
      view.current?.setDuet(current?.guest?.status === 'accepted', current?.parts); // duet: the lyrics take on the two colors
      clock.current.setPlaying(state.playback === 'playing');
      view.current?.setOffset(current?.lyric_offset ?? 0);
      // with the song on the server (or in the cloud) the lyrics come straight; on the Owner's computer only the TV reaches them and relays them through the server
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
      // the song ended (or the Host skipped it): shows the end and sends the singer back to the Room
      const score = state.scoring ? state.scoreboard.find((entry) => entry.id === itemRef.current)?.score ?? null : null;
      setEnded({ title: itemInfo.current?.title ?? t('stage.songFallback'), score });
    } else if (state.scoring && ended.score === null) {
      // the Score can arrive a moment after the end
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
          <p className="stage-where">{t('stage.where', { code })}</p>
          <h1 className="stage-song">{current?.title ?? '…'}</h1>
          <p className="stage-artist">
            {current?.artist ?? ''}
            {current?.singers ? ` — ${current.singers}` : ''}
          </p>
        </div>
        <div className="stage-actions">
          <LyricsSize />
          <button type="button" onClick={leave}>
            {t('stage.back')}
          </button>
        </div>
      </header>

      <InviteNotice state={state} onRespond={(invited, accept) => void respondInvite(code, invited, accept)} />

      {/* whoever is singing can call someone in the Room to sing along, even with the song already playing */}
      {item?.mine && (
        <div className="stage-duet">
          {item.guest?.status === 'pending' && <span className="duet-note">{t('duet.pending', { name: item.guest.name })}</span>}
          {item.guest?.status === 'accepted' && <span className="duet-note ok">{t('duet.withOk', { name: item.guest.name })}</span>}
          {item.guest ? (
            <button type="button" className="ghost" onClick={() => void api('DELETE', `/api/rooms/${code}/queue/${item.id}/invite`, undefined, code).catch(() => undefined)}>
              {t(item.guest.status === 'accepted' ? 'duet.remove' : 'duet.cancelInvite')}
            </button>
          ) : (
            <button type="button" className="ghost" onClick={() => setChoosing(true)}>
              {t('duet.invite')}
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

      {state?.interlude?.phase === 'stage' && state.interlude.item_id === item?.id && <StageCall state={state} />}

      <section className="lyrics stage-lyrics" aria-live="off">
        <p className="line prev" ref={lyricsRefs.prev} />
        <p className="line current" ref={lyricsRefs.current} />
        <p className="line next" ref={lyricsRefs.next} />
        <p className="line next2" ref={lyricsRefs.next2} />
      </section>

      {item?.guest?.status === 'accepted' && (
        <p className="duet-legend stage-legend" aria-label={t('tvp.duetAria')}>
          <span data-part={myPart(item)}>{t('stage.myParts', { part: partName(myPart(item)) })}</span>
          <span data-part={myPart(item) === 'a' ? 'b' : 'a'}>{item.mine ? item.guest.name : item.added_by}</span>
          <span data-part="both">{t('tvp.both')}</span>
        </p>
      )}

      <footer className="stage-bottom" role="status">
        {ended ? (
          <div className="stage-end">
            <strong>{t('stage.over')}</strong>
            {ended.score !== null ? (
              <span>
                {t('stage.yourScore', { score: ended.score })} <BetaTag />
              </span>
            ) : null}
            <small>{t('stage.returning')}</small>
          </div>
        ) : status === 'reconnecting' ? (
          t('ctl.reconnecting')
        ) : state && !state.tv_connected ? (
          t('stage.noTv')
        ) : paused ? (
          t('stage.paused')
        ) : (
          ''
        )}
      </footer>
      <ReactionLayer items={reactions.items} />
    </main>
  );
}
