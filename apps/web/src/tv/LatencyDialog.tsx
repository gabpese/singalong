// The TV's delay calibration: the sound takes a while to reach the ears (speaker, Bluetooth, HDMI) and the microphone takes a while to deliver
// what it picked up. It can measure itself (clicks in the speakers, heard by the microphone) or be adjusted by hand.
import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n/index.ts';
import { clampLatency, MAX_LATENCY_MS, splitRoundTrip } from '../lib/latency.ts';
import { measureRoundTrip } from '../lib/latency-measure.ts';
import type { TvController } from './controller';

type Status = { kind: 'idle' | 'measuring' | 'ok' | 'fail' | 'error'; text?: string };

export function LatencyDialog({ controller, onClose }: { controller: TvController | null; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [latency, setLatency] = useState(() => controller?.latency ?? { output: 0, input: 0 });
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);

  const apply = (next: { output: number; input: number }) => setLatency(controller?.setLatency(next) ?? next);

  async function measure() {
    setStatus({ kind: 'measuring' });
    try {
      const result = await measureRoundTrip();
      if (result.roundTripMs === null) return setStatus({ kind: 'fail' });
      // the output the browser reports (or the one the person already set, if larger); the rest of the round trip belongs to the input
      const next = splitRoundTrip(result.roundTripMs, Math.max(result.outputLatencyMs, latency.output));
      apply(next);
      setStatus({ kind: 'ok', text: t('lat.result', { total: result.roundTripMs, output: next.output, input: next.input }) });
    } catch {
      setStatus({ kind: 'error' });
    }
  }

  const measuring = status.kind === 'measuring';
  return (
    <dialog ref={dialog} className="jukebox-dialog latency-dialog" aria-labelledby="latency-title" onClose={onClose} onClick={(event) => event.target === event.currentTarget && !measuring && onClose()}>
      <div className="jukebox-body">
        <h2 id="latency-title">{t('lat.title')}</h2>
        <p className="muted">{t('lat.intro')}</p>

        <label className="field latency-field">
          <span>{t('lat.output', { ms: latency.output })}</span>
          <input type="range" min={0} max={MAX_LATENCY_MS} step={10} value={latency.output} disabled={measuring} onChange={(event) => apply({ ...latency, output: clampLatency(event.target.value) })} />
          <small className="hint">{t('lat.outputHint')}</small>
        </label>
        <label className="field latency-field">
          <span>{t('lat.input', { ms: latency.input })}</span>
          <input type="range" min={0} max={MAX_LATENCY_MS} step={10} value={latency.input} disabled={measuring} onChange={(event) => apply({ ...latency, input: clampLatency(event.target.value) })} />
          <small className="hint">{t('lat.inputHint')}</small>
        </label>

        <p className={`hint${status.kind === 'fail' || status.kind === 'error' ? ' error' : ''}`} role="status">
          {status.kind === 'measuring' && t('lat.measuring')}
          {status.kind === 'ok' && status.text}
          {status.kind === 'fail' && t('lat.fail')}
          {status.kind === 'error' && t('lat.error')}
        </p>

        <div className="jukebox-actions">
          <button type="button" className="primary" disabled={measuring} onClick={() => void measure()}>
            {t('lat.measure')}
          </button>
          <button type="button" disabled={measuring} onClick={() => apply({ output: 0, input: 0 })}>
            {t('lat.reset')}
          </button>
          <button type="button" disabled={measuring} onClick={onClose}>
            {t('lat.close')}
          </button>
        </div>
      </div>
    </dialog>
  );
}
