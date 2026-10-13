// Lista de cantores da TV (a música atual e as próximas), compartilhada pela TV que toca e pela aba TV da sala.
import { songChip } from '../lib/queue-view.js';
import type { QueueItem } from '../lib/types';

const UPCOMING_SHOWN = 5;
export const titleOf = (item: QueueItem) => item.title ?? item.video_id;

function QueueRow({ item, badge, isCurrent = false }: { item: QueueItem; badge: string; isCurrent?: boolean }) {
  return (
    <li className={isCurrent ? 'is-current' : ''}>
      <span className="mark">{badge}</span>
      <span className="text">
        <strong>{item.singers}</strong>
        <small>
          {titleOf(item)}
          {item.song.ready ? '' : ` · ${songChip(item.song).label.toLowerCase()}`}
        </small>
      </span>
    </li>
  );
}

/** Lista lateral: a música atual e as próximas 5, na ordem em que vão tocar (para ceder a vez com conhecimento de causa). */
export function QueueBox({ current, upcoming }: { current: QueueItem | null; upcoming: QueueItem[] }) {
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

