// Guia de melodia: as notas da voz original como barras que andam para a esquerda, com a afinação de quem canta por cima
// (verde = no tom, vermelho = fora). O "agora" fica a 1/4 da esquerda; o que vem aí, à direita, para a pessoa se preparar.
import { useEffect, useRef } from 'react';
import { t } from '../i18n/index.js';
import { easeRange, foldToNearestOctave, isGood, makeScale, noteAt, notesInWindow, pitchRange, SECONDS_AFTER, SECONDS_BEFORE } from '../lib/melody-guide.js';
import type { TvController } from './controller';

const css = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

export function PitchGuide({ controller }: { controller: TvController | null }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const element = canvas.current;
    const context = element?.getContext('2d');
    if (!element || !context || !controller) return undefined;
    const colors = { accent: css('--accent', '#ffd34d'), ok: css('--ok', '#4ade80'), bad: css('--bad', '#ff7b7b'), dim: css('--dim', '#8f8fab'), line: css('--line', '#2a2a42'), fg: css('--fg', '#f4f4f8') };
    let range: { low: number; high: number } | null = null;
    let frame = 0;

    const draw = () => {
      frame = requestAnimationFrame(draw);
      const ratio = window.devicePixelRatio || 1;
      const width = element.clientWidth;
      const height = element.clientHeight;
      if (!width || !height) return;
      if (element.width !== Math.round(width * ratio) || element.height !== Math.round(height * ratio)) {
        element.width = Math.round(width * ratio);
        element.height = Math.round(height * ratio);
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0);
      context.clearRect(0, 0, width, height);

      const frameData = controller.guideFrame();
      const { notes, transpose, position, trail } = frameData;
      const visible = notesInWindow(notes, position - SECONDS_BEFORE, position + SECONDS_AFTER);
      range = easeRange(range, pitchRange(visible, transpose));
      const scale = makeScale({ position, width, height: height - 8, range });
      const top = 4;

      // uma linha fraca em cada Dó, para a pessoa se situar na altura
      if (range) {
        context.strokeStyle = colors.line;
        context.lineWidth = 1;
        for (let note = Math.ceil(range.low); note <= range.high; note++) {
          if (((note % 12) + 12) % 12 !== 0) continue;
          const y = top + scale.y(note);
          context.beginPath();
          context.moveTo(0, y);
          context.lineTo(width, y);
          context.stroke();
        }
      }

      // as notas da original
      for (const n of visible) {
        const x1 = scale.x(n.start);
        const x2 = scale.x(n.end);
        const y = top + scale.y(n.note + transpose) - scale.barHeight / 2;
        const active = n.start <= position && position < n.end;
        context.fillStyle = active ? colors.fg : n.end <= position ? colors.dim : colors.accent;
        context.globalAlpha = n.end <= position ? 0.45 : 1;
        context.beginPath();
        context.roundRect(Math.max(0, x1), y, Math.max(3, x2 - Math.max(0, x1)), scale.barHeight, scale.barHeight / 2);
        context.fill();
      }
      context.globalAlpha = 1;

      // o agora
      context.strokeStyle = colors.fg;
      context.globalAlpha = 0.6;
      context.beginPath();
      context.moveTo(scale.nowX, 0);
      context.lineTo(scale.nowX, height);
      context.stroke();
      context.globalAlpha = 1;

      // o que a pessoa cantou (na oitava mais perto da nota da original, para aparecer junto da barra)
      let lastReference: number | null = null;
      let previous: { x: number; y: number } | null = null;
      for (const point of trail) {
        const reference = noteAt(notes, point.t, transpose);
        if (reference !== null) lastReference = reference;
        if (point.midi === null || lastReference === null) {
          previous = null;
          continue;
        }
        const sung = foldToNearestOctave(point.midi, lastReference);
        const x = scale.nowX + (point.t - position) * (width / (SECONDS_BEFORE + SECONDS_AFTER));
        const y = top + scale.y(sung);
        const good = isGood(point.midi, reference ?? lastReference);
        context.strokeStyle = good ? colors.ok : colors.bad;
        context.fillStyle = good ? colors.ok : colors.bad;
        if (previous && x - previous.x < 40) {
          context.lineWidth = 3;
          context.beginPath();
          context.moveTo(previous.x, previous.y);
          context.lineTo(x, y);
          context.stroke();
        }
        context.beginPath();
        context.arc(x, y, 3.5, 0, Math.PI * 2);
        context.fill();
        previous = { x, y };
      }
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [controller]);

  return <canvas ref={canvas} className="pitch-guide" role="img" aria-label={t('melody.aria')} />;
}
