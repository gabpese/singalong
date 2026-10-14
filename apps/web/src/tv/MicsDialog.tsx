// Microfones da TV: quais entram nas caixas junto com a música (um por cantor). O primeiro marcado também faz a pontuação.
import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n/index.js';
import { listMicrophones, MAX_MICS } from '../lib/voice.js';
import type { TvController } from './controller';

type Mic = { id: string; label: string };

export function MicsDialog({ controller, onClose }: { controller: TvController | null; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [devices, setDevices] = useState<Mic[] | null>(null);
  const [chosen, setChosen] = useState<Mic[]>(() => controller?.mics ?? []);
  const [filter, setFilter] = useState(() => controller?.voiceFilter ?? true);

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
    let cancelled = false;
    void listMicrophones().then((list: Mic[]) => {
      if (!cancelled) setDevices(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  function toggle(mic: Mic) {
    const isChosen = chosen.some((item) => item.id === mic.id);
    if (!isChosen && chosen.length >= MAX_MICS) return;
    const next = isChosen ? chosen.filter((item) => item.id !== mic.id) : [...chosen, mic];
    setChosen(controller?.setMics(next) ?? next);
  }

  // microfones escolhidos que não aparecem mais na lista (desconectados) continuam na lista, para poder desmarcá-los
  const known = devices ?? [];
  const missing = chosen.filter((mic) => !known.some((item) => item.id === mic.id));
  const rows = [...known, ...missing.map((mic) => ({ ...mic, label: `${mic.label || mic.id.slice(0, 8)}` }))];
  const full = chosen.length >= MAX_MICS;

  return (
    <dialog ref={dialog} className="jukebox-dialog mics-dialog" aria-labelledby="mics-title" onClose={onClose} onClick={(event) => event.target === event.currentTarget && onClose()}>
      <div className="jukebox-body">
        <h2 id="mics-title">{t('mics.title')}</h2>
        <p className="muted">{t('mics.intro', { max: MAX_MICS })}</p>
        {devices === null && <p className="hint">{t('mics.loading')}</p>}
        {devices !== null && rows.length === 0 && <p className="hint">{t('mics.none')}</p>}
        <ul className="mic-list">
          {rows.map((mic) => {
            const index = chosen.findIndex((item) => item.id === mic.id);
            const checked = index >= 0;
            return (
              <li key={mic.id}>
                <label className="check">
                  <input type="checkbox" checked={checked} disabled={!checked && full} onChange={() => toggle(mic)} />
                  <span>
                    {mic.label}
                    {index === 0 && <small className="muted"> — {t('mics.first')}</small>}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
        {full && <p className="hint">{t('mics.max', { max: MAX_MICS })}</p>}
        <label className="check">
          <input type="checkbox" checked={filter} onChange={(event) => setFilter(controller?.setVoiceFilter(event.target.checked) ?? event.target.checked)} />
          <span>
            {t('mics.filter')}
            <small className="muted"> — {t('mics.filterHint')}</small>
          </span>
        </label>
        <div className="jukebox-actions">
          <button type="button" onClick={onClose}>
            {t('mics.close')}
          </button>
        </div>
      </div>
    </dialog>
  );
}
