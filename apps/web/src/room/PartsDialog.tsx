// A divisão da letra do dueto: quem canta cada linha (voz 1, voz 2 ou os dois juntos). Começa pela divisão que a música já tem
// (a escolhida pelos cantores ou a automática) e, ao salvar, vale para a música em qualquer sala.
import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n/index.js';
import { decodeParts, encodeParts, splitParts } from '../lib/duet.js';
import type { LyricCue, QueueItem } from '../lib/types';
import { useRoom } from './context';

type Part = 'a' | 'b' | 'both' | null;
const CHOICES: { part: 'a' | 'b' | 'both'; label: string }[] = [
  { part: 'a', label: 'parts.one' },
  { part: 'b', label: 'parts.two' },
  { part: 'both', label: 'parts.both' },
];

export function PartsDialog({ item, onClose }: { item: QueueItem; onClose: () => void }) {
  const { act, toast, loadCues } = useRoom();
  const dialog = useRef<HTMLDialogElement>(null);
  const [cues, setCues] = useState<LyricCue[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [parts, setParts] = useState<Part[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    let cancelled = false;
    void loadCues(item).then((found: LyricCue[] | null) => {
      if (cancelled) return;
      if (!found?.length) return setFailed(true);
      setCues(found);
      setParts((decodeParts(item.parts ?? null, found.length) ?? splitParts(found)) as Part[]);
    });
    return () => {
      cancelled = true;
    };
  }, [item, loadCues]);

  const names = { a: item.added_by, b: item.guest?.name ?? '' };

  async function save(value: string | null) {
    setBusy(true);
    try {
      await act('PUT', `/songs/${item.video_id}/parts`, { parts: value });
      toast(t(value === null ? 'parts.reset' : 'parts.saved'));
      onClose();
    } catch {
      setBusy(false); // o erro já foi avisado
    }
  }

  return (
    <dialog ref={dialog} className="jukebox-dialog parts-dialog" aria-labelledby="parts-title" onClose={onClose} onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div className="jukebox-body">
        <h2 id="parts-title">{t('parts.title')}</h2>
        <p className="muted">{t('parts.intro', { one: names.a, two: names.b })}</p>
        {cues === null && !failed && <p className="hint">{t('parts.loading')}</p>}
        {failed && <p className="hint error">{t('parts.noLyrics')}</p>}
        {cues && (
          <ol className="parts-list">
            {cues.map((cue, index) => (
              <li key={index} className={cue.text.trim() ? '' : 'empty-line'}>
                <span className="parts-text">{cue.text.trim() || '♪'}</span>
                {cue.text.trim() && (
                  <span className="parts-choices" role="radiogroup" aria-label={t('parts.lineAria', { n: index + 1 })}>
                    {CHOICES.map(({ part, label }) => (
                      <button
                        key={part}
                        type="button"
                        role="radio"
                        aria-checked={parts[index] === part}
                        className={`part-btn${parts[index] === part ? ' on' : ''}`}
                        data-part={part}
                        title={part === 'a' ? names.a : part === 'b' ? names.b : undefined}
                        onClick={() => setParts((current) => current.map((value, i) => (i === index ? part : value)))}
                      >
                        {t(label)}
                      </button>
                    ))}
                  </span>
                )}
              </li>
            ))}
          </ol>
        )}
        <div className="jukebox-actions">
          <button type="button" className="primary" disabled={busy || !cues} onClick={() => void save(encodeParts(parts))}>
            {t('parts.save')}
          </button>
          <button type="button" disabled={busy} onClick={() => void save(null)}>
            {t('parts.auto')}
          </button>
          <button type="button" disabled={busy} onClick={onClose}>
            {t('parts.cancel')}
          </button>
        </div>
      </div>
    </dialog>
  );
}
