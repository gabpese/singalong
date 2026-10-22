// Reactions that float up the screen (TV, the Room's TV tab and Stage): each one rises and goes away on its own. Decoration only: screen readers skip them.
import { useCallback, useEffect, useRef, useState } from 'react';
import { addFloating, glyphOf, REACTION_LIFETIME_MS } from '../lib/reactions.ts';
import type { ReactionKind } from '../lib/types.ts';

export interface FloatingReaction {
  id: number;
  kind: ReactionKind;
  name?: string;
  /** The horizontal position (% of the width). */
  x: number;
}

export function useReactionLayer() {
  const [items, setItems] = useState<FloatingReaction[]>([]);
  const counter = useRef(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  const push = useCallback((kind: ReactionKind, name?: string) => {
    const id = ++counter.current;
    const item: FloatingReaction = { id, kind, name, x: 6 + Math.random() * 88 };
    setItems((current) => addFloating(current, item));
    timers.current.push(setTimeout(() => setItems((current) => current.filter((r) => r.id !== id)), REACTION_LIFETIME_MS));
  }, []);

  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  return { items, push };
}

export function ReactionLayer({ items }: { items: FloatingReaction[] }) {
  return (
    <div className="reaction-layer" aria-hidden="true">
      {items.map((item) => (
        <span key={item.id} className="reaction" style={{ left: `${item.x}%` }}>
          <span className="reaction-glyph">{glyphOf(item.kind)}</span>
          {item.name && <small>{item.name}</small>}
        </span>
      ))}
    </div>
  );
}
