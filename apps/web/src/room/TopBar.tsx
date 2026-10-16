// Topo da sala (código e estado da TV) e a barra de abas. Os atalhos e ajustes ficam na barra lateral (RoomRail).
import { useEffect, useRef } from 'react';
import type { RoomState } from '../lib/types';
import { t } from '../i18n/index.js';
import { Icon } from '../ui/Icon';
import { LanguageSwitch } from '../ui/LanguageSwitch';
import { type Tab, useRoom, type View } from './context';
import type { ConnectionStatus } from './useRoomConnection';

function tvStatusText(state: RoomState | null, status: ConnectionStatus) {
  if (!state) return status === 'connected' ? t('conn.connected') : status === 'reconnecting' ? t('conn.reconnecting') : t('conn.connecting');
  if (status !== 'connected') return t('conn.reconnecting');
  return (
    <>
      <Icon name="display" />
      {` ${state.tv_connected ? t('conn.tvOn') : t('conn.tvOff')}`}
    </>
  );
}

export function TopBar({ state, status, view, onView }: { state: RoomState | null; status: ConnectionStatus; view: View; onView: (view: View) => void }) {
  const { code } = useRoom();
  const header = useRef<HTMLElement>(null);
  // a barra lateral fica logo abaixo do topo, qualquer que seja a altura dele (idioma, estado da TV...): o topo diz a sua medida
  useEffect(() => {
    const element = header.current;
    if (!element) return undefined;
    const publish = () => document.documentElement.style.setProperty('--topbar-h', `${element.offsetHeight}px`);
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return (
    <header className="topbar" ref={header}>
      <div className="topbar-main">
        <h1>
          <img className="topbar-mark" src="/brand/mark.svg" alt="" />
          {t('room.word')} <span>{code}</span>
        </h1>
        <p className={`tv-status${status === 'connected' && state?.tv_connected ? ' on' : ''}`}>{tvStatusText(state, status)}</p>
      </div>
      <LanguageSwitch />
      <div className="view-switch" role="tablist" aria-label={t('view.aria')}>
        <button type="button" role="tab" aria-selected={view === 'room'} className={view === 'room' ? 'active' : ''} onClick={() => onView('room')}>
          {t('view.room')}
        </button>
        <button type="button" role="tab" aria-selected={view === 'tv'} className={view === 'tv' ? 'active' : ''} onClick={() => onView('tv')}>
          <Icon name="display" /> {t('view.tv')}
        </button>
      </div>
    </header>
  );
}

export function TabBar({ tab, onTab, queueCount, hidden }: { tab: Tab; onTab: (tab: Tab) => void; queueCount: number; hidden: boolean }) {
  return (
    <nav className="tabbar" aria-label={t('tabs.aria')} hidden={hidden}>
      <button type="button" className={tab === 'queue' ? 'active' : ''} aria-current={tab === 'queue' ? 'page' : undefined} onClick={() => onTab('queue')}>
        <Icon name="singing" />
        <span className="label">
          {t('tabs.queue')} <b>{queueCount ? `(${queueCount})` : ''}</b>
        </span>
      </button>
      <button type="button" className={tab === 'add' ? 'active' : ''} aria-current={tab === 'add' ? 'page' : undefined} onClick={() => onTab('add')}>
        <Icon name="add-song" />
        <span className="label">{t('tabs.add')}</span>
      </button>
      <button type="button" className={tab === 'library' ? 'active' : ''} aria-current={tab === 'library' ? 'page' : undefined} onClick={() => onTab('library')}>
        <Icon name="musics" />
        <span className="label">{t('tabs.library')}</span>
      </button>
    </nav>
  );
}
