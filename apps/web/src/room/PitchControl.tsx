// The song's key: two buttons ("Mais grave" and "Mais agudo") and, between them, the note the person will sing in, highlighted. Whoever cannot
// edit only sees the note. The same picker serves the Queue, the playing song and the preview.
import { t } from '../i18n/index.ts';
import { noteSummary } from '../lib/music.ts';
import type { QueueItem, SongKey } from '../lib/types.ts';
import { Icon } from '../ui/Icon';
import { useRoom } from './context';

const RANGE = 6;
export const clampPitch = (value: number) => Math.max(-RANGE, Math.min(RANGE, value));

/** The adjustment's ruler: the center is the original key and the steps light up toward the side the key was moved to. */
function Meter({ pitch }: { pitch: number }) {
  const steps = Array.from({ length: RANGE * 2 + 1 }, (_, i) => i - RANGE);
  return (
    <span className="pitch-meter" aria-hidden="true">
      {steps.map((step) => {
        const lit = step === 0 || (pitch > 0 ? step > 0 && step <= pitch : step < 0 && step >= pitch);
        return <i key={step} className={`${lit ? 'on' : ''}${step === 0 ? ' mid' : ''}${step > 0 ? ' up' : step < 0 ? ' down' : ''}`.trim()} />;
      })}
    </span>
  );
}

interface PickerProps {
  pitch: number;
  songKey: SongKey | null;
  /** Without `onChange` the picker only shows the key (for whoever cannot edit it). */
  onChange?: (pitch: number) => void;
}

export function PitchPicker({ pitch, songKey, onChange }: PickerProps) {
  const note = noteSummary(songKey, pitch);
  const caption = t(pitch === 0 ? 'pitch.original' : pitch > 0 ? 'pitch.higher' : 'pitch.lower');
  return (
    <div className={`pitch${onChange ? '' : ' static'}`} data-pitch={pitch} title={t('pitch.title')}>
      {onChange && (
        <button type="button" className="pitch-btn" onClick={() => onChange(clampPitch(pitch - 1))} disabled={pitch <= -RANGE}>
          <Icon name="minus" />
          <span>{t('pitch.lower')}</span>
        </button>
      )}
      <div className="pitch-value" aria-live="polite">
        <span className="pitch-caption">{caption}</span>
        {note && (
          <strong className="pitch-note">
            <span className="sr-only">{t('pitch.note')} </span>
            {note}
          </strong>
        )}
        <Meter pitch={pitch} />
      </div>
      {onChange && (
        <button type="button" className="pitch-btn" onClick={() => onChange(clampPitch(pitch + 1))} disabled={pitch >= RANGE}>
          <Icon name="plus" />
          <span>{t('pitch.higher')}</span>
        </button>
      )}
    </div>
  );
}

export function PitchControl({ item }: { item: QueueItem }) {
  const { act } = useRoom();
  if (!item.can_edit) return item.pitch ? <PitchPicker pitch={item.pitch} songKey={item.song.key} /> : null;
  return <PitchPicker pitch={item.pitch} songKey={item.song.key} onChange={(value) => void act('PATCH', `/queue/${item.id}`, { pitch: value }).catch(() => {})} />;
}
