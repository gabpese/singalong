// Topo da sala (código e estado da TV) e a barra de abas. Os atalhos e ajustes ficam na barra lateral (RoomRail).
import type { RoomState } from '../lib/types';
import { Icon } from '../ui/Icon';
import { type Tab, useRoom, type View } from './context';
import type { ConnectionStatus } from './useRoomConnection';

function tvStatusText(state: RoomState | null, status: ConnectionStatus) {
  if (!state) return status === 'connected' ? 'Conectado' : status === 'reconnecting' ? 'Reconectando à sala…' : 'Conectando…';
  if (status !== 'connected') return 'Reconectando à sala…';
  return (
    <>
      <Icon name="display" />
      {state.tv_connected ? ' TV conectada' : ' TV desconectada'}
    </>
  );
}

export function TopBar({ state, status, view, onView }: { state: RoomState | null; status: ConnectionStatus; view: View; onView: (view: View) => void }) {
  const { code } = useRoom();

  return (
    <header className="topbar">
      <div className="topbar-main">
        <h1>
          <Icon name="singing" />
          Sala <span>{code}</span>
        </h1>
        <p className={`tv-status${status === 'connected' && state?.tv_connected ? ' on' : ''}`}>{tvStatusText(state, status)}</p>
      </div>
      <div className="view-switch" role="tablist" aria-label="Sala ou TV">
        <button type="button" role="tab" aria-selected={view === 'room'} className={view === 'room' ? 'active' : ''} onClick={() => onView('room')}>
          Sala
        </button>
        <button type="button" role="tab" aria-selected={view === 'tv'} className={view === 'tv' ? 'active' : ''} onClick={() => onView('tv')}>
          <Icon name="display" /> TV
        </button>
      </div>
    </header>
  );
}

export function TabBar({ tab, onTab, queueCount, hidden }: { tab: Tab; onTab: (tab: Tab) => void; queueCount: number; hidden: boolean }) {
  return (
    <nav className="tabbar" aria-label="Seções" hidden={hidden}>
      <button type="button" className={tab === 'queue' ? 'active' : ''} onClick={() => onTab('queue')}>
        <Icon name="singing" />
        <span className="label">
          Fila <b>{queueCount ? `(${queueCount})` : ''}</b>
        </span>
      </button>
      <button type="button" className={tab === 'add' ? 'active' : ''} onClick={() => onTab('add')}>
        <Icon name="add-song" />
        <span className="label">Adicionar</span>
      </button>
      <button type="button" className={tab === 'library' ? 'active' : ''} onClick={() => onTab('library')}>
        <Icon name="musics" />
        <span className="label">Músicas</span>
      </button>
    </nav>
  );
}
