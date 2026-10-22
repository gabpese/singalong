// The Intermission on the TV, in two poster scenes made with the Room's creatures (no video):
//  - Applause: the audience (the creatures of the people in the Room) jumps, confetti falls and whoever just sang is cheered; with
//    scoring on, the Score shows big in the middle;
//  - Taking the stage: the creature of whoever is next (both of them, in a duet) leaves the dressing room, climbs the stairs and
//    reaches the microphone, while the countdown says when the song starts. The TV has already loaded the audio.
// The animations last as long as the phase (`total_ms`) and start from where the phase is, for a TV that joins in the middle of the Intermission.
import { Blobatar } from '@blobatar/react';
import { happy, love, surprised, wink } from 'blobatar/expression';
import 'blobatar/motion.css';
import { type CSSProperties, useEffect, useState } from 'react';
import { t } from '../i18n/index.ts';
import { finalMessage } from '../lib/score-view.ts';
import type { Interlude as InterludeState, RoomState } from '../lib/types.ts';
import { SingerBlobs } from '../ui/SingerBlobs';
import { useInterlude } from '../ui/useInterlude';
import { playApplause } from './applause-sound';

const CROWD_SIZE = 14; // the audience is filled out with generic creatures when the Room has few people
const CROWD_FACES = [happy, love, surprised, wink];
const CONFETTI = 46;
const APPLAUSE_SOUND_SECONDS = 9; // the clapping dies out before the phase ends

/** A "random" number fixed per position: the same audience and the same confetti on every TV, without jumping around on each draw. */
const seeded = (index: number, salt: number) => {
  const x = Math.sin(index * 12.9898 + salt * 78.233) * 43758.5453;
  return x - Math.floor(x);
};

function timing(phase: InterludeState, elapsedMs: number): CSSProperties {
  return { '--dur': `${phase.total_ms}ms`, '--late': `-${Math.round(elapsedMs)}ms` } as CSSProperties;
}

function Crowd({ people }: { people: RoomState['people'] }) {
  const names = people.map((person) => person.name).slice(0, CROWD_SIZE);
  while (names.length < CROWD_SIZE) names.push(`plateia-${names.length}`);
  return (
    <div className="crowd" aria-hidden="true">
      {names.map((name, index) => (
        <span
          key={`${index}-${name}`}
          className="crowd-one"
          style={{ '--i': index, '--jump': `${0.42 + seeded(index, 1) * 0.35}s`, '--wait': `${seeded(index, 2) * -0.8}s`, '--size': `${0.85 + seeded(index, 3) * 0.4}` } as CSSProperties}
        >
          <Blobatar name={name} background={false} animate="always" expression={CROWD_FACES[index % CROWD_FACES.length]} className="crowd-blob" />
        </span>
      ))}
    </div>
  );
}

function Confetti() {
  return (
    <div className="confetti" aria-hidden="true">
      {Array.from({ length: CONFETTI }, (_, index) => (
        <i
          key={index}
          className={`bit c${index % 3}`}
          style={{ '--x': `${seeded(index, 4) * 100}%`, '--fall': `${2.6 + seeded(index, 5) * 2.4}s`, '--wait': `${seeded(index, 6) * -4}s`, '--spin': `${seeded(index, 7) * 720 - 360}deg` } as CSSProperties}
        />
      ))}
    </div>
  );
}

function ApplauseScene({ phase, elapsedMs, people, scoring }: { phase: InterludeState; elapsedMs: number; people: RoomState['people']; scoring: boolean }) {
  const [late] = useState(elapsedMs); // fixed: the animations' delay cannot change on each draw of the clock
  // the clapping plays once per applauded song (from the point the phase is at, if the TV joined in the middle)
  useEffect(() => playApplause(Math.min(APPLAUSE_SOUND_SECONDS, (phase.total_ms - elapsedMs) / 1000)), [phase.item_id]); // eslint-disable-line react-hooks/exhaustive-deps
  const showScore = scoring && phase.score !== null;
  return (
    <section className="interlude applause" style={timing(phase, late)} aria-label={t('interlude.applauseFor', { who: phase.singers })}>
      <div className="beams" aria-hidden="true" />
      <Confetti />
      <div className="interlude-sheet">
        <i className="tape" aria-hidden="true" />
        <p className="interlude-kicker">{t('interlude.applause')}</p>
        <h1 className="interlude-who">
          <SingerBlobs item={phase} animate expression={happy} />
          <span>{phase.singers}</span>
        </h1>
        {phase.title && <p className="interlude-song">{phase.title}</p>}
        {showScore && (
          <div className="score-stamp" role="status">
            <strong>{phase.score}</strong>
            <span>{t('interlude.points')}</span>
            <small>{finalMessage(phase.score ?? 0)}</small>
          </div>
        )}
      </div>
      <Crowd people={people} />
    </section>
  );
}

function StageScene({ phase, elapsedMs, seconds }: { phase: InterludeState; elapsedMs: number; seconds: number }) {
  const [late] = useState(elapsedMs); // fixed: the animations' delay cannot change on each draw of the clock
  const duet = phase.guest?.status === 'accepted';
  const walkers = duet ? [{ added_by: phase.added_by, guest: null }, { added_by: phase.guest!.name, guest: null }] : [{ added_by: phase.added_by, guest: null }];
  return (
    <section className="interlude stage-up" style={timing(phase, late)} aria-label={t('interlude.stage')}>
      <header className="stage-up-head">
        <div>
          <p className="interlude-kicker">{t('interlude.stage')}</p>
          <h1 className="interlude-who">
            <span>{phase.singers}</span>
          </h1>
          <p className="interlude-song">{[phase.title, phase.artist].filter(Boolean).join(' — ')}</p>
        </div>
        <p className="countdown" role="timer" aria-live="off">
          <small>{t('interlude.startsIn')}</small>
          <strong>{seconds}</strong>
        </p>
      </header>
      <div className="scene" aria-hidden="true">
        <i className="valance" />
        <i className="spot" />
        <div className="door">
          <span className="door-sign">{t('interlude.door')}</span>
          <i className="door-leaf" />
        </div>
        <i className="floor" />
        <i className="stairs" />
        <i className="platform" />
        <i className="mic-stand" />
        {walkers.map((walker, index) => (
          <span key={index} className={`walker w${index}`}>
            <span className="walker-bob">
              <SingerBlobs item={walker} animate expression={index ? wink : happy} />
            </span>
          </span>
        ))}
      </div>
      <p className="interlude-hint">{t('interlude.grabMic')}</p>
    </section>
  );
}

/** The scene of the Intermission under way (or nothing, outside the Intermission). */
export function Interlude({ room }: { room: RoomState | null }) {
  const phase = room?.interlude ?? null;
  const clock = useInterlude(phase);
  if (!room || !phase || !clock) return null;
  const key = `${phase.phase}:${phase.item_id}`; // a new scene in each phase: the animations start over
  return phase.phase === 'applause' ? (
    <ApplauseScene key={key} phase={phase} elapsedMs={clock.elapsedMs} people={room.people} scoring={room.scoring} />
  ) : (
    <StageScene key={key} phase={phase} elapsedMs={clock.elapsedMs} seconds={clock.seconds} />
  );
}
