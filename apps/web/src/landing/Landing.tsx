// Página inicial: a imagem (TV, notebook e celular) de um lado e as ações do outro, como a tela de boas-vindas do app do dono:
// criar uma sala (e abrir a TV), entrar numa sala pelo código e baixar o app.
import { type FormEvent, useEffect, useState } from 'react';
import { t } from '../i18n/index.ts';
import { api, setHostToken } from '../lib/identity.ts';
import { detectSystem } from '../lib/platform.ts';
import { LanguageSwitch } from '../ui/LanguageSwitch';
import { Logo } from '../ui/Logo';

interface ApiError extends Error {
  status?: number;
}

type System = 'windows' | 'macos' | 'linux';

interface Download {
  system: System;
  arch: string;
  file: string;
  url: string;
}

interface HomeConfig {
  app_download_url: string | null;
  app_latest_version: string | null;
  app_page_url: string | null;
  app_downloads: Download[];
}

const NO_CONFIG: HomeConfig = { app_download_url: null, app_latest_version: null, app_page_url: null, app_downloads: [] };

const systemName = (system: System) => t(`home.system.${system}`);

/** Uma dica ao lado de um botão: abre com o mouse em cima, com o foco do teclado ou com um toque (no celular não existe "mouse em cima"). */
function InfoTip({ id, label, text }: { id: string; label: string; text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span className="info-tip" onMouseLeave={() => setOpen(false)}>
      <button
        type="button"
        className="info-tip-btn"
        aria-label={label}
        aria-describedby={id}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => event.key === 'Escape' && setOpen(false)}
        onBlur={() => setOpen(false)}
      >
        i
      </button>
      <span id={id} role="tooltip" className={`info-tip-text${open ? ' open' : ''}`}>
        {text}
      </span>
    </span>
  );
}

/** O botão de baixar o instalador de um sistema (abre numa aba nova; o arquivo vem do GitHub, não daqui). O Mac leva a dica do Intel ao lado. */
function DownloadButton({ item }: { item: Download }) {
  return (
    <div className="download-row">
      <a className="button" href={item.url} target="_blank" rel="noopener noreferrer">
        {t('home.download.buttonFor', { system: t(`home.system.${item.system}`) })}
      </a>
      {item.system === 'macos' && <InfoTip id="mac-tip" label={t('home.download.macTipLabel')} text={t('home.download.macIntelNo')} />}
    </div>
  );
}

/**
 * O bloco do app: um botão por sistema, o do visitante primeiro (detectado pelo navegador) e os outros logo abaixo, sempre à vista. O botão do Mac
 * tem ao lado a dica de que Macs Intel não são suportados (o navegador não distingue Intel de Apple Silicon). Celular e tablet recebem também a
 * explicação. Sem endereço configurado, nada aparece.
 */
function DownloadApp({ config }: { config: HomeConfig }) {
  if (!config.app_downloads.length) return null;
  const system = detectSystem(navigator.userAgent);
  const detected = system === 'windows' || system === 'macos' || system === 'linux' ? system : null;
  const primary = config.app_downloads.find((item) => item.system === detected);
  const others = config.app_downloads.filter((item) => item.system !== detected);
  return (
    <section className="mode-card mode-download download-card" aria-labelledby="download-title">
      <h2 id="download-title">{t('home.download.title')}</h2>
      <p className="hint">{t('home.download.hint')}</p>
      {primary && <DownloadButton item={primary} />}
      {detected === 'macos' && <p className="hint">{t('home.download.macNote')}</p>}
      {detected === 'linux' && <p className="hint">{t('home.download.linuxNote')}</p>}
      {!detected && <p className="hint">{t('home.download.computerOnly')}</p>}
      {detected && <h3 className="download-others">{t('home.download.others')}</h3>}
      {others.map((item) => (
        <DownloadButton key={item.system} item={item} />
      ))}
      {config.app_page_url && (
        <a className="download-more" href={config.app_page_url} target="_blank" rel="noopener noreferrer">
          {t('home.download.page')}
        </a>
      )}
    </section>
  );
}

export function Landing() {
  const [code, setCode] = useState('');
  const [message, setMessage] = useState('');
  const [config, setConfig] = useState<HomeConfig>(NO_CONFIG);

  useEffect(() => {
    api('GET', '/api/config')
      .then((data: Partial<HomeConfig>) =>
        setConfig({
          app_download_url: data.app_download_url ?? null,
          app_latest_version: data.app_latest_version ?? null,
          app_page_url: data.app_page_url ?? null,
          app_downloads: Array.isArray(data.app_downloads) ? data.app_downloads : [],
        }),
      )
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
      <header className="home-top">
        <LanguageSwitch />
      </header>

      <div className="home-hero">
        <div>
          <h1 className="home-logo">
            <Logo />
          </h1>
          <p className="lead">{t('landing.lead')}</p>
        </div>
        <div className="home-art">
          <img src="/brand/mark.svg" alt={t('home.artAlt')} />
        </div>
      </div>

      <main className="home-modes">
        <section className="mode-card mode-host" aria-labelledby="mode-host-title">
          <h2 id="mode-host-title">{t('landing.create.title')}</h2>
          <p className="hint">{t('landing.create.hint')}</p>
          <p className="poster-tag" aria-hidden="true">
            {t('brand.tagline')}
          </p>
          <div className="mode-action">
            <button type="button" className="primary big" onClick={createRoom}>
              {t('landing.create.button')}
            </button>
          </div>
        </section>

        <section className="mode-card mode-join" aria-labelledby="mode-join-title">
          <h2 id="mode-join-title">{t('landing.join.title')}</h2>
          <p className="hint">{t('landing.join.hint')}</p>
          <div className="mode-action">
            <form className="join-form" autoComplete="off" onSubmit={join}>
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
          </div>
        </section>
        <DownloadApp config={config} />
      </main>

      <p className={`hint${message ? ' error' : ''}`} role="status">
        {message}
      </p>
    </div>
  );
}
