// Nível das vozes de apoio (backing vocals) e da voz original (guia para cantar) de uma música da fila, de 0 a 100 %. Só aparece
// nas músicas que têm o arquivo; quem escolheu a música (ou o anfitrião) arrasta, os demais só veem o valor.
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { t } from '../i18n/index.js';
import type { QueueItem } from '../lib/types';
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

/** A voz original isolada como guia para cantar (só nas músicas que têm o arquivo da voz). */
export function GuideControl({ item }: { item: QueueItem }) {
  return <LevelControl item={item} field="guide" />;
}

function LevelControl({ item, field }: { item: QueueItem; field: Field }) {
  const text = TEXTS[field];
  const current = item[field];
  const { act } = useRoom();
  const [drag, setDrag] = useState<number | null>(null); // valor enquanto a barra está sendo arrastada
  const [pending, setPending] = useState<number | null>(null); // o que foi enviado, até o servidor confirmar
  const slider = useRef<HTMLInputElement>(null);
  const commitRef = useRef<(level: number) => void>(() => {});

  commitRef.current = (level: number) => {
    setDrag(null);
    setPending(level);
    void act('PATCH', `/queue/${item.id}`, { [field]: level }).catch(() => {});
  };
  // o "change" nativo só dispara ao SOLTAR a barra: é aí que o nível vai para a TV
  const editable = item.can_edit;
  useEffect(() => {
    const element = slider.current;
    if (!element) return;
    const onChange = () => commitRef.current(Number(element.value));
    element.addEventListener('change', onChange);
    return () => element.removeEventListener('change', onChange);
  }, [editable]);
  // a barra mostra o que foi enviado até o servidor confirmar (ou desistir): sem pular de volta ao valor antigo
  useEffect(() => {
    if (pending === null) return;
    if (current === pending) return setPending(null);
    const timer = setTimeout(() => setPending(null), PENDING_MS);
    return () => clearTimeout(timer);
  }, [pending, current]);

  if (!text.hasFile(item)) return null; // a música não tem essa trilha separada
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
