// The melody guide: the original voice's notes as bars that move to the left, with the singer's pitch drawn over them
// (green = in tune, red = off). "Now" sits 1/4 from the left; what is coming, on the right, so the person can get ready.
import { useEffect, useRef } from 'react';
import { t } from '../i18n/index.ts';
import { easeRange, foldToNearestOctave, isGood, makeScale, noteAt, notesInWindow, PART_COLORS, pitchRange, SECONDS_AFTER, SECONDS_BEFORE } from '../lib/melody-guide.ts';
import type { GuideFrame, TvController } from './controller';

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
      const { notes, transpose, position, trail, trailB, partAt } = frameData;
      const visible = notesInWindow(notes, position - SECONDS_BEFORE, position + SECONDS_AFTER);
      range = easeRange(range, pitchRange(visible, transpose));
      const scale = makeScale({ position, width, height: height - 8, range });
      const top = 4;

      // a faint line on each C, so the person can tell how high they are
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

      // the original's notes
      for (const n of visible) {
        const x1 = scale.x(n.start);
        const x2 = scale.x(n.end);
        const y = top + scale.y(n.note + transpose) - scale.barHeight / 2;
        const active = n.start <= position && position < n.end;
        const part = partAt ? partAt((n.start + n.end) / 2) : null; // duet: the color of whoever sings this note
        const base = part === 'a' ? PART_COLORS.a : part === 'b' ? PART_COLORS.b : partAt && !part ? colors.dim : colors.accent;
        const left = Math.max(0, x1);
        context.fillStyle = base;
        context.globalAlpha = n.end <= position ? 0.4 : 1;
        context.beginPath();
        context.roundRect(left, y, Math.max(3, x2 - left), scale.barHeight, scale.barHeight / 2);
        context.fill();
        if (active) {
          // the current note gets a light outline, without losing the color of whoever sings it
          context.globalAlpha = 1;
          context.strokeStyle = colors.fg;
          context.lineWidth = 2;
          context.stroke();
        }
      }
      context.globalAlpha = 1;

      // now
      context.strokeStyle = colors.fg;
      context.globalAlpha = 0.6;
      context.beginPath();
      context.moveTo(scale.nowX, 0);
      context.lineTo(scale.nowX, height);
      context.stroke();
      context.globalAlpha = 1;

      // what each person sang (in the octave closest to the original's note, so it shows next to the bar)
      const drawTrail = (points: GuideFrame['trail']) => {
        let lastReference: number | null = null;
        let previous: { x: number; y: number } | null = null;
        for (const point of points) {
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
      drawTrail(trail);
      drawTrail(trailB);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [controller]);

  return <canvas ref={canvas} className="pitch-guide" role="img" aria-label={t('melody.aria')} />;
}
