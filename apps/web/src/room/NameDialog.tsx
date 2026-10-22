// The first thing on joining the Room: who are you? The name shows in the Queue, in the duet invitations and in the scoring, so the
// modal does not close without it (later the person can still change it in the "Adicionar" tab).
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { t } from '../i18n/index.ts';

export function NameDialog({ code, onName }: { code: string; onName: (name: string) => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState('');

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (value.trim()) onName(value.trim());
  }

  return (
    <dialog
      ref={dialog}
      className="jukebox-dialog name-dialog"
      aria-labelledby="name-title"
      onCancel={(event) => event.preventDefault()} // Esc does not close it: the name is required
    >
      <form className="jukebox-body" onSubmit={submit}>
        <h2 id="name-title">{t('name.welcome', { code })}</h2>
        <p className="muted">{t('name.body')}</p>
        <label className="field">
          <span>{t('name.label')}</span>
          <input
            type="text"
            maxLength={30}
            autoFocus
            autoComplete="nickname"
            placeholder={t('name.placeholder')}
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
        <div className="jukebox-actions">
          <button type="submit" className="primary" disabled={!value.trim()}>
            {t('name.button')}
          </button>
        </div>
      </form>
    </dialog>
  );
}
