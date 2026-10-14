// Página inicial: a imagem (TV, notebook e celular) de um lado e as ações do outro, como a tela de boas-vindas do app do dono:
// criar uma sala (e abrir a TV), entrar numa sala pelo código e baixar o app.
import { type FormEvent, useEffect, useState } from 'react';
import { t } from '../i18n/index.js';
import { api, setHostToken } from '../lib/identity.js';
import { canInstallApp } from '../lib/platform.js';
import { Icon } from '../ui/Icon';
import { LanguageSwitch } from '../ui/LanguageSwitch';

interface ApiError extends Error {
  status?: number;
}

interface HomeConfig {
  app_download_url: string | null;
  app_latest_version: string | null;
}

/** O bloco do app: o botão de baixar (computador Windows) ou a explicação (celular e outros sistemas). Sem endereço, nada. */
function DownloadApp({ config }: { config: HomeConfig }) {
  if (!config.app_download_url) return null;
  const installable = canInstallApp(navigator.userAgent);
  return (
    <section className="card download-card" aria-labelledby="download-title">
      <h2 id="download-title">{t('home.download.title')}</h2>
      <p className="hint">{t('home.download.hint')}</p>
      {installable ? (
        <a className="button" href={config.app_download_url} target="_blank" rel="noopener noreferrer">
          {config.app_latest_version ? t('home.download.buttonVersion', { version: config.app_latest_version }) : t('home.download.button')}
        </a>
      ) : (
        <>
          <p className="hint">{t('home.download.windowsOnly')}</p>
          <a className="download-more" href={config.app_download_url} target="_blank" rel="noopener noreferrer">
            {t('home.download.page')}
          </a>
        </>
      )}
    </section>
  );
}

export function Landing() {
  const [code, setCode] = useState('');
  const [message, setMessage] = useState('');
  const [config, setConfig] = useState<HomeConfig>({ app_download_url: null, app_latest_version: null });

  useEffect(() => {
    api('GET', '/api/config')
      .then((data: HomeConfig) => setConfig({ app_download_url: data.app_download_url ?? null, app_latest_version: data.app_latest_version ?? null }))
      .catch(() => undefined); // sem a configuração, a página só não mostra o botão de baixar
  }, []);

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
    <div className="home">
      <div className="home-art">
        <img src="/welcome.png" alt={t('home.artAlt')} />
      </div>
      <main className="home-panel">
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

        <DownloadApp config={config} />

        <p className={`hint${message ? ' error' : ''}`} role="status">
          {message}
        </p>
      </main>
    </div>
  );
}
