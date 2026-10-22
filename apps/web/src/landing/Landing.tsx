// The home page: the picture (TV, laptop and phone) on one side and the actions on the other, like the Owner's app welcome screen:
// create a Room (and open the TV), join a Room by its code and download the app.
import { type FormEvent, useEffect, useState } from 'react';
import { t } from '../i18n/index.ts';
import { api, setHostToken } from '../lib/identity.ts';
import { detectSystem } from '../lib/platform.ts';
import type { ApiError, CreatedRoom, Download, PublicConfig } from '../lib/types.ts';
import { LanguageSwitch } from '../ui/LanguageSwitch';
import { Logo } from '../ui/Logo';

type System = Download['system'];

type HomeConfig = Pick<PublicConfig, 'app_download_url' | 'app_latest_version' | 'app_page_url' | 'app_downloads'>;

const NO_CONFIG: HomeConfig = { app_download_url: null, app_latest_version: null, app_page_url: null, app_downloads: [] };

const systemName = (system: System) => t(`home.system.${system}`);

/** A tip beside a button: opens on hover, on keyboard focus or on a tap (a phone has no "hover"). */
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

/** The button that downloads one system's installer (opens in a new tab; the file comes from GitHub, not from here). The Mac one has the Intel tip beside it. */
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
 * The app's block: one button per system, the visitor's first (detected by the browser) and the others right below, always in view. The Mac
 * button has beside it the tip that Intel Macs are not supported (the browser cannot tell Intel from Apple Silicon). Phones and tablets also get
 * the explanation. With no address configured, nothing shows.
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
    api<Partial<PublicConfig>>('GET', '/api/config')
      .then((data) =>
        setConfig({
          app_download_url: data.app_download_url ?? null,
          app_latest_version: data.app_latest_version ?? null,
          app_page_url: data.app_page_url ?? null,
          app_downloads: Array.isArray(data.app_downloads) ? data.app_downloads : [],
        }),
      )
      .catch(() => undefined); // without the setting, the page simply leaves out the download button
  }, []);

  async function createRoom() {
    try {
      const { code: roomCode, host_token: token } = await api<CreatedRoom>('POST', '/api/rooms');
      setHostToken(roomCode, token);
      // opened inside the click so the browser does not block the TV's tab; the Room has an "Abrir TV" button if it does
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
