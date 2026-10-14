// Página inicial: a imagem (TV, notebook e celular) de um lado e as ações do outro, como a tela de boas-vindas do app do dono:
// criar uma sala (e abrir a TV), entrar numa sala pelo código e baixar o app.
import { type FormEvent, useEffect, useState } from 'react';
import { t } from '../i18n/index.js';
import { api, setHostToken } from '../lib/identity.js';
import { detectSystem } from '../lib/platform.js';
import { Icon } from '../ui/Icon';
import { LanguageSwitch } from '../ui/LanguageSwitch';

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

/** Um botão de baixar o instalador de um sistema (abre numa aba nova; o arquivo vem do GitHub, não daqui). */
function DownloadButton({ item, version }: { item: Download; version: string | null }) {
  const system = systemName(item.system);
  return (
    <a className="button" href={item.url} target="_blank" rel="noopener noreferrer">
      {version ? t('home.download.buttonForVersion', { system, version }) : t('home.download.buttonFor', { system })}
    </a>
  );
}

/**
 * O Mac não diz se é Intel ou Apple Silicon (o navegador sempre se apresenta como Intel): a pessoa responde. O app só existe para Apple Silicon;
 * quem tem Mac Intel recebe a explicação em vez de um arquivo que não abre.
 */
function MacChoice({ item, version }: { item: Download | undefined; version: string | null }) {
  const [chip, setChip] = useState<'silicon' | 'intel' | null>(null);
  return (
    <div className="mac-choice">
      <p id="mac-ask" className="hint">
        {t('home.download.macAsk')}
      </p>
      <div className="row" role="group" aria-labelledby="mac-ask">
        <button type="button" className={chip === 'silicon' ? 'primary' : undefined} aria-pressed={chip === 'silicon'} onClick={() => setChip('silicon')}>
          {t('home.download.macSilicon')}
        </button>
        <button type="button" className={chip === 'intel' ? 'primary' : undefined} aria-pressed={chip === 'intel'} onClick={() => setChip('intel')}>
          {t('home.download.macIntel')}
        </button>
      </div>
      {chip === 'silicon' && item && (
        <>
          <DownloadButton item={item} version={version} />
          <p className="hint">{t('home.download.macNote')}</p>
        </>
      )}
      {chip === 'intel' && <p className="hint">{t('home.download.macIntelNo')}</p>}
    </div>
  );
}

/**
 * O bloco do app: o botão do sistema do visitante (no Mac, antes a pergunta "qual é o seu Mac?"), a lista dos outros sistemas, sempre à
 * vista, e a página com todas as versões. Celular e tablet recebem a explicação. Sem endereço configurado, nada aparece.
 */
function DownloadApp({ config }: { config: HomeConfig }) {
  if (!config.app_downloads.length) return null;
  const system = detectSystem(navigator.userAgent);
  const version = config.app_latest_version;
  const of = (name: System) => config.app_downloads.find((item) => item.system === name);
  const detected = system === 'windows' || system === 'macos' || system === 'linux' ? system : null;
  const others = config.app_downloads.filter((item) => item.system !== detected);
  const primary = detected && detected !== 'macos' ? of(detected) : undefined;
  return (
    <section className="card download-card" aria-labelledby="download-title">
      <h2 id="download-title">{t('home.download.title')}</h2>
      <p className="hint">{t('home.download.hint')}</p>
      {primary && <DownloadButton item={primary} version={version} />}
      {primary?.system === 'linux' && <p className="hint">{t('home.download.linuxNote')}</p>}
      {detected === 'macos' && <MacChoice item={of('macos')} version={version} />}
      {!detected && <p className="hint">{t('home.download.computerOnly')}</p>}
      <h3 className="download-others">{t('home.download.others')}</h3>
      <ul className="download-list">
        {others.map((item) => (
          <li key={item.system}>
            <a href={item.url} target="_blank" rel="noopener noreferrer">
              {systemName(item.system)}
            </a>
            <span className="muted small"> · {item.file}</span>
          </li>
        ))}
      </ul>
      {others.some((item) => item.system === 'macos') && <p className="hint small">{t('home.download.macIntelNo')}</p>}
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
