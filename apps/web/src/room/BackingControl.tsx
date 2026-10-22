// The level of the backing vocals and of the original voice (a guide to sing along with) of a song in the Queue, from 0 to 100 %. It only shows
// on songs that have the file; whoever chose the song (or the Host) drags it, everyone else only sees the value.
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { t } from '../i18n/index.ts';
import type { QueueItem } from '../lib/types.ts';
import { useRoom } from './context';

const PENDING_MS = 1500;

type Field = 'backing' | 'guide';

const TEXTS: Record<Field, { label: string; staticLabel: string; aria: string; hasFile: (item: QueueItem) => boolean }> = {
  backing: { label: 'backing.label', staticLabel: 'backing.static', aria: 'backing.aria', hasFile: (item) => Boolean(item.song.media?.backing) },
  guide: { label: 'guide.label', staticLabel: 'guide.static', aria: 'guide.aria', hasFile: (item) => Boolean(item.song.media?.vocals) },
};

export function BackingControl({ item }: { item: QueueItem }) {
  return <LevelControl item={item} field="backing" />;
}

/** The isolated original voice as a guide to sing along with (only on songs that have the voice's file). */
export function GuideControl({ item }: { item: QueueItem }) {
  return <LevelControl item={item} field="guide" />;
}

function LevelControl({ item, field }: { item: QueueItem; field: Field }) {
  const text = TEXTS[field];
  const current = item[field];
  const { act } = useRoom();
  const [drag, setDrag] = useState<number | null>(null); // the value while the bar is being dragged
  const [pending, setPending] = useState<number | null>(null); // what was sent, until the server confirms it
  const slider = useRef<HTMLInputElement>(null);
  const commitRef = useRef<(level: number) => void>(() => {});

  commitRef.current = (level: number) => {
    setDrag(null);
    setPending(level);
    void act('PATCH', `/queue/${item.id}`, { [field]: level }).catch(() => {});
  };
  // the native "change" only fires on RELEASING the bar: that is when the level goes to the TV
  const editable = item.can_edit;
  useEffect(() => {
    const element = slider.current;
    if (!element) return;
    const onChange = () => commitRef.current(Number(element.value));
    element.addEventListener('change', onChange);
    return () => element.removeEventListener('change', onChange);
  }, [editable]);
  // the bar shows what was sent until the server confirms it (or gives up): no jumping back to the old value
  useEffect(() => {
    if (pending === null) return;
    if (current === pending) return setPending(null);
    const timer = setTimeout(() => setPending(null), PENDING_MS);
    return () => clearTimeout(timer);
  }, [pending, current]);

  if (!text.hasFile(item)) return null; // the song does not have this track separated
  const level = drag ?? pending ?? current;

  if (!editable) {
    return current > 0 ? <span className="muted small">{t(text.staticLabel, { n: current })}</span> : null;
  }
  return (
    <div className="backing-row">
      <span className="muted small">{t(text.label)}</span>
      <input
        ref={slider}
        type="range"
        className="seek"
        min={0}
        max={100}
        step={5}
        value={level}
        aria-label={t(text.aria)}
        aria-valuetext={`${level}%`}
        style={{ '--fill': `${level}%` } as CSSProperties}
        onChange={(event) => setDrag(Number(event.target.value))}
      />
      <span className="backing-value">{`${level}%`}</span>
    </div>
  );
}
