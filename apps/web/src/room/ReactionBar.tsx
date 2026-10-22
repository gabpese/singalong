// The phone's Reaction buttons: a tap sends applause, fire... that floats up the TV's screen.
import { useState } from 'react';
import { t } from '../i18n/index.ts';
import { REACTIONS } from '../lib/reactions.ts';
import type { ReactionKind } from '../lib/types.ts';

export function ReactionBar({ onReact }: { onReact: (kind: ReactionKind) => void }) {
  const [pop, setPop] = useState<string | null>(null); // the button that was just tapped (a visual pop to confirm it)
  return (
    <div className="reaction-bar" role="group" aria-label={t('react.group')}>
      {REACTIONS.map(({ kind, glyph }) => (
        <button
          key={kind}
          type="button"
          className={pop === kind ? 'pop' : ''}
          aria-label={t(`react.${kind}`)}
          title={t(`react.${kind}`)}
          onClick={() => {
            onReact(kind as ReactionKind);
            navigator.vibrate?.(10);
            setPop(kind);
            setTimeout(() => setPop((current) => (current === kind ? null : current)), 180);
          }}
        >
          <span aria-hidden="true">{glyph}</span>
        </button>
      ))}
    </div>
  );
}
