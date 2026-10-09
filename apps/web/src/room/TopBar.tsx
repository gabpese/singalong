// Topo da sala (código, estado da TV, menu com links e ajustes do anfitrião) e a barra de abas.
import { type ReactNode, useRef, useState } from 'react';
import { hostToken } from '../lib/identity.js';
import type { RoomState } from '../lib/types';
import { Icon } from '../ui/Icon';
import { type Tab, useRoom } from './context';
import type { ConnectionStatus } from './useRoomConnection';

/** Ajuste do anfitrião: o clique vale na hora e volta atrás só se o servidor recusar (sem "piscar" à espera da resposta). */
function HostSetting({ field, checked, children }: { field: 'fair' | 'scoring'; checked: boolean; children: ReactNode }) {
  const { act, isHost } = useRoom();
  const [pending, setPending] = useState<boolean | null>(null);
  return (
    <label className="check" hidden={!isHost}>
      <input
        type="checkbox"
        checked={pending ?? checked}
        onChange={(event) => {
          setPending(event.target.checked);
          act('PATCH', '', { [field]: event.target.checked })
            .catch(() => {})
            .finally(() => setPending(null));
        }}
      />
      <span>{children}</span>
    </label>
  );
}

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

export function TopBar({ state, status }: { state: RoomState | null; status: ConnectionStatus }) {
  const { code, isHost, toast } = useRoom();
  const menu = useRef<HTMLDetailsElement>(null);
  const closeMenu = () => {
    if (menu.current) menu.current.open = false;
  };

  async function copyText(text: string, okMessage: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast(okMessage);
    } catch {
      window.prompt('Copie o link:', text); // navegador sem permissão de área de transferência (http fora de localhost)
    }
  }

  return (
    <header className="topbar">
      <div className="topbar-main">
        <h1>
          <Icon name="singing" />
          Sala <span>{code}</span>
        </h1>
        <p className={`tv-status${status === 'connected' && state?.tv_connected ? ' on' : ''}`}>{tvStatusText(state, status)}</p>
      </div>
      <details className="menu" ref={menu}>
        <summary aria-label="Opções da sala">⋯</summary>
        <div className="menu-panel">
          <button
            type="button"
            className="has-icon"
            onClick={() => {
              closeMenu();
              window.open(`tv.html?room=${code}`, '_blank');
            }}
          >
            <Icon name="display" />
            Abrir TV
          </button>
          <button
            type="button"
            className="has-icon"
            onClick={() => {
              closeMenu();
              void copyText(`${location.origin}/room.html?room=${code}`, 'Link da sala copiado!');
            }}
          >
            <Icon name="link" />
            Copiar link da sala
          </button>
          <button
            type="button"
            className="has-icon"
            hidden={!isHost}
            onClick={() => {
              closeMenu();
              void copyText(
                `${location.origin}/room.html?room=${code}#host=${hostToken(code)}`,
                'Link de anfitrião copiado! Quem abrir controla a sala.',
              );
            }}
          >
            <Icon name="host" />
            Copiar link de anfitrião
          </button>
          <HostSetting field="scoring" checked={Boolean(state?.scoring)}>
            Pontuação pelo microfone
            <br />
            <small className="muted">a TV compara a afinação de quem canta com a voz original (precisa de microfone na TV)</small>
          </HostSetting>
          <HostSetting field="fair" checked={Boolean(state?.fair)}>
            Rodízio justo
            <br />
            <small className="muted">a mesma pessoa não canta duas seguidas quando há outra esperando</small>
          </HostSetting>
        </div>
      </details>
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
