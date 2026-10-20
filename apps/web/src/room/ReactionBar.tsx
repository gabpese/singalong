// Os botões de reação do celular: um toque manda um aplauso, fogo... que sobe pela tela da TV.
import { useState } from 'react';
import { t } from '../i18n/index.ts';
import { REACTIONS } from '../lib/reactions.ts';
import type { ReactionKind } from '../lib/types.ts';

export function ReactionBar({ onReact }: { onReact: (kind: ReactionKind) => void }) {
  const [pop, setPop] = useState<string | null>(null); // o botão que acabou de ser tocado (um estalo visual de confirmação)
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
