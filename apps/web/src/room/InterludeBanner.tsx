// The Intermission on the phone: who is being applauded (with the Score, if there was scoring) or who is taking the stage,
// with the countdown. The Host can skip the Intermission ("Começar agora").
import { t } from '../i18n/index.ts';
import type { RoomState } from '../lib/types.ts';
import { SingerBlobs } from '../ui/SingerBlobs';
import { useInterlude } from '../ui/useInterlude';
import { useRoom } from './context';

export function InterludeBanner({ state, controls = true }: { state: RoomState; controls?: boolean }) {
  const { act, isHost } = useRoom();
  const phase = state.interlude;
  const clock = useInterlude(phase);
  if (!phase || !clock) return null;
  const applause = phase.phase === 'applause';
  const many = phase.guest?.status === 'accepted';
  return (
    <div className={`interlude-banner ${phase.phase}`} role="status">
      <SingerBlobs item={phase} />
      <div className="interlude-banner-text">
        <strong>
          {applause ? t('interlude.applauseFor', { who: phase.singers }) : t(many ? 'interlude.stageFor.many' : 'interlude.stageFor.one', { who: phase.singers })}
        </strong>
        <span className="muted small">
          {applause && state.scoring && phase.score !== null ? `${t('interlude.points.with', { n: phase.score })} · ` : ''}
          {applause ? t('interlude.nextIn', { n: clock.seconds }) : t('interlude.startsIn.long', { n: clock.seconds })}
        </span>
      </div>
      {controls && isHost && (
        <button type="button" className="interlude-start" onClick={() => void act('POST', '/player/start').catch(() => {})}>
          {t('interlude.startNow')}
        </button>
      )}
    </div>
  );
}
