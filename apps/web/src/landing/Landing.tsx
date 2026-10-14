// Entrada: criar uma sala (e abrir a TV) ou entrar numa sala pelo código.
import { type FormEvent, useState } from 'react';
import { api, setHostToken } from '../lib/identity.js';
import { t } from '../i18n/index.js';
import { Icon } from '../ui/Icon';
import { LanguageSwitch } from '../ui/LanguageSwitch';

interface ApiError extends Error {
  status?: number;
}

export function Landing() {
  const [code, setCode] = useState('');
  const [message, setMessage] = useState('');

  async function createRoom() {
    try {
      const { code: roomCode, host_token: token } = await api('POST', '/api/rooms');
      setHostToken(roomCode, token);
      // aberta dentro do clique para o navegador não bloquear a aba da TV; na sala há um botão "Abrir TV" se bloquear
      window.open(`tv.html?room=${roomCode}`, '_blank');
      location.href = `room.html?room=${roomCode}`;
    } catch (err) {
      setMessage((err as Error).message);
    }
  }

  async function join(event: FormEvent) {
    event.preventDefault();
    const roomCode = code.trim().toUpperCase();
    try {
      await api('GET', `/api/rooms/${encodeURIComponent(roomCode)}`);
      location.href = `room.html?room=${roomCode}`;
    } catch (err) {
      const error = err as ApiError;
      setMessage(error.status === 404 ? t('landing.join.notFound', { code: roomCode }) : error.message);
    }
  }

  return (
    <main className="landing-page">
      <LanguageSwitch />
      <h1>
        <Icon name="singing" />
        Singalong
      </h1>
      <p className="lead">{t('landing.lead')}</p>

      <section className="card">
        <h2>{t('landing.create.title')}</h2>
        <p className="hint">{t('landing.create.hint')}</p>
        <button type="button" className="primary big" onClick={createRoom}>
          {t('landing.create.button')}
        </button>
      </section>

      <section className="card">
        <h2>{t('landing.join.title')}</h2>
        <form className="row" autoComplete="off" onSubmit={join}>
          <input
            className="join-code"
            type="text"
            inputMode="text"
            maxLength={8}
            placeholder={t('landing.join.placeholder')}
            aria-label={t('landing.join.aria')}
            required
            value={code}
            onChange={(event) => setCode(event.target.value)}
          />
          <button type="submit">{t('landing.join.button')}</button>
        </form>
      </section>

      <p className={`hint${message ? ' error' : ''}`} role="status">
        {message}
      </p>
    </main>
  );
}
