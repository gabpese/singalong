// The voice from the TV's microphone in the speakers: the Host turns it on (with a notice about directional microphones) and sets the volume.
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import { t } from '../i18n/index.ts';
import { tRich } from '../i18n/rich';
import { useRoom } from './context';

const PENDING_MS = 1500;

/** The voice's volume (0 to 100 %): only the Host sees it, and only with the voice on. The value goes to the TV on RELEASING the bar. */
export function VoiceVolume() {
  const { act, state, isHost } = useRoom();
  const [drag, setDrag] = useState<number | null>(null);
  const [pending, setPending] = useState<number | null>(null);
  const slider = useRef<HTMLInputElement>(null);
  const commitRef = useRef<(level: number) => void>(() => {});
  const volume = state?.voice_volume ?? 40;
  const visible = isHost && Boolean(state?.voice);

  commitRef.current = (level: number) => {
    setDrag(null);
    setPending(level);
    void act('PATCH', '', { voice_volume: level }).catch(() => {});
  };
  useEffect(() => {
    const element = slider.current;
    if (!element) return undefined;
    const onChange = () => commitRef.current(Number(element.value));
    element.addEventListener('change', onChange);
    return () => element.removeEventListener('change', onChange);
  }, [visible]);
  useEffect(() => {
    if (pending === null) return undefined;
    if (volume === pending) {
      setPending(null);
      return undefined;
    }
    const timer = setTimeout(() => setPending(null), PENDING_MS);
    return () => clearTimeout(timer);
  }, [pending, volume]);

  if (!visible) return null;
  const level = drag ?? pending ?? volume;
  return (
    <div className="backing-row voice-row">
      <span className="muted small">{t('voice.volume')}</span>
      <input
        ref={slider}
        type="range"
        className="seek"
        min={0}
        max={100}
        step={5}
        value={level}
        aria-label={t('voice.volumeAria')}
        aria-valuetext={`${level}%`}
        style={{ '--fill': `${level}%` } as CSSProperties}
        onChange={(event) => setDrag(Number(event.target.value))}
      />
      <span className="backing-value">{`${level}%`}</span>
    </div>
  );
}

/** The notice before turning the voice on: an open microphone near the speaker makes that squeal (feedback). */
export function VoiceDialog({ onConfirm, onCancel }: { onConfirm: () => void; onCancel: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);
  return (
    <dialog
      ref={dialog}
      className="jukebox-dialog voice-dialog"
      aria-labelledby="voice-title"
      onClose={onCancel}
      onClick={(event) => {
        if (event.target === event.currentTarget) onCancel();
      }}
    >
      <div className="jukebox-body">
        <h2 id="voice-title">{t('voicedlg.title')}</h2>
        <p>{t('voicedlg.lead')}</p>
        <p>{tRich('voicedlg.directional')}</p>
        <ul className="voice-tips">
          <li>{t('voicedlg.tip1')}</li>
          <li>{t('voicedlg.tip2')}</li>
          <li>{t('voicedlg.tip3')}</li>
          <li>{t('voicedlg.tip4')}</li>
        </ul>
        <div className="jukebox-actions">
          <button type="button" className="primary" onClick={onConfirm}>
            {t('voicedlg.confirm')}
          </button>
          <button type="button" onClick={onCancel}>
            {t('voicedlg.cancel')}
          </button>
        </div>
      </div>
    </dialog>
  );
}
