// Tom da música (semitons): botões − e + para quem pode editar; só o texto para os demais.
import { formatPitch } from '../lib/queue-view.js';
import type { QueueItem } from '../lib/types';
import { useRoom } from './context';

export const clampPitch = (value: number) => Math.max(-6, Math.min(6, value));

export function PitchControl({ item }: { item: QueueItem }) {
  const { act } = useRoom();
  const set = (value: number) => void act('PATCH', `/queue/${item.id}`, { pitch: clampPitch(value) }).catch(() => {});
  if (!item.can_edit) return item.pitch ? <span className="pitch static">Tom {formatPitch(item.pitch)}</span> : null;
  return (
    <span className="pitch" title="Tom da música (semitons)">
      <button type="button" aria-label="Tom mais grave" onClick={() => set(item.pitch - 1)} disabled={item.pitch <= -6}>
        −
      </button>
      <span className="pitch-value">Tom {formatPitch(item.pitch)}</span>
      <button type="button" aria-label="Tom mais agudo" onClick={() => set(item.pitch + 1)} disabled={item.pitch >= 6}>
        +
      </button>
    </span>
  );
}
