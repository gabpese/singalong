// O relógio do intervalo entre músicas: o servidor diz quanto faltava quando mandou o estado e cada aparelho conta o resto sozinho
// (os relógios dos aparelhos não precisam bater com o do servidor). Uma fase nova (aplausos ou subida ao palco de outra música)
// recomeça a conta.
import { useEffect, useRef, useState } from 'react';
import type { Interlude } from '../lib/types.ts';

export interface InterludeClock {
  /** Quanto já passou desde o começo da fase (ms), contando o que passou antes de este aparelho receber o estado. */
  elapsedMs: number;
  /** Quanto falta (ms). */
  leftMs: number;
  /** Os segundos que faltam, arredondados para cima (o número da contagem regressiva). */
  seconds: number;
}

export function useInterlude(interlude: Interlude | null | undefined): InterludeClock | null {
  const started = useRef<{ key: string; at: number } | null>(null);
  const [, setTick] = useState(0);
  const key = interlude ? `${interlude.phase}:${interlude.item_id}` : '';

  if (!interlude) started.current = null;
  else if (started.current?.key !== key) {
    started.current = { key, at: performance.now() - Math.max(0, interlude.total_ms - interlude.left_ms) };
  }

  useEffect(() => {
    if (!key) return undefined;
    const timer = setInterval(() => setTick((n) => n + 1), 250);
    return () => clearInterval(timer);
  }, [key]);

  if (!interlude || !started.current) return null;
  const elapsedMs = Math.min(interlude.total_ms, performance.now() - started.current.at);
  const leftMs = Math.max(0, interlude.total_ms - elapsedMs);
  return { elapsedMs, leftMs, seconds: Math.ceil(leftMs / 1000) };
}
