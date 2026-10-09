// Nível das vozes de apoio (backing vocals) de uma música da fila, de 0 a 100 %. Só aparece nas músicas que têm o arquivo
// de apoio; quem escolheu a música (ou o anfitrião) arrasta, os demais só veem o valor.
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import type { QueueItem } from '../lib/types';
import { useRoom } from './context';

const PENDING_MS = 1500;

export function BackingControl({ item }: { item: QueueItem }) {
  const { act } = useRoom();
  const [drag, setDrag] = useState<number | null>(null); // valor enquanto a barra está sendo arrastada
  const [pending, setPending] = useState<number | null>(null); // o que foi enviado, até o servidor confirmar
  const slider = useRef<HTMLInputElement>(null);
  const commitRef = useRef<(level: number) => void>(() => {});

  commitRef.current = (level: number) => {
    setDrag(null);
    setPending(level);
    void act('PATCH', `/queue/${item.id}`, { backing: level }).catch(() => {});
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
    if (item.backing === pending) return setPending(null);
    const timer = setTimeout(() => setPending(null), PENDING_MS);
    return () => clearTimeout(timer);
  }, [pending, item.backing]);

  if (!item.song.media?.backing) return null; // a música não tem vozes de apoio separadas
  const level = drag ?? pending ?? item.backing;

  if (!editable) {
    return item.backing > 0 ? <span className="muted small">{`Vozes de apoio ${item.backing}%`}</span> : null;
  }
  return (
    <div className="backing-row">
      <span className="muted small">Vozes de apoio</span>
      <input
        ref={slider}
        type="range"
        className="seek"
        min={0}
        max={100}
        step={5}
        value={level}
        aria-label="Nível das vozes de apoio"
        aria-valuetext={`${level}%`}
        style={{ '--fill': `${level}%` } as CSSProperties}
        onChange={(event) => setDrag(Number(event.target.value))}
      />
      <span className="backing-value">{`${level}%`}</span>
    </div>
  );
}
