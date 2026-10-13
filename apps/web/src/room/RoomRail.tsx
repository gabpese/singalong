// A barra lateral da sala: os atalhos e os ajustes do anfitrião sempre à vista, só com ícones (o texto fica no tooltip e no
// nome acessível). Em telas largas é uma coluna à esquerda; no celular vira uma faixa logo abaixo do topo.
import { type ReactNode, useState } from 'react';
import { hostToken } from '../lib/identity.js';
import type { RoomState } from '../lib/types';
import { Icon, type IconName } from '../ui/Icon';
import { useRoom } from './context';
import { VoiceDialog, VoiceVolume } from './VoiceControl';

/** O app do dono já tem as abas TV e Anfitrião: lá "Abrir TV" não faz sentido. */
const insideOwnerApp = typeof navigator !== 'undefined' && navigator.userAgent.includes('Electron');

/** Um botão de ação (copiar, abrir): só o ícone; o texto aparece ao passar o mouse ou focar. */
function RailButton({ icon, label, tip, onClick }: { icon: IconName; label: string; tip: string; onClick: () => void }) {
  return (
    <button type="button" className="rail-btn" aria-label={label} data-tip={tip} onClick={onClick}>
      <Icon name={icon} />
    </button>
  );
}

/** Um ajuste ligado/desligado (switch): o clique vale na hora e volta atrás só se o servidor recusar. */
function RailSwitch({ icon, label, tip, checked, onToggle }: { icon: IconName; label: string; tip: string; checked: boolean; onToggle: (next: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={label} data-tip={tip} className={`rail-switch${checked ? ' on' : ''}`} onClick={() => onToggle(!checked)}>
      <Icon name={icon} />
      <span className="sw" aria-hidden="true" />
    </button>
  );
}

/** Ajuste do anfitrião que vai no PATCH da sala. */
function useHostField(field: 'fair' | 'scoring' | 'voice', checked: boolean, names: [string, string]) {
  const { act, toast } = useRoom();
  const [pending, setPending] = useState<boolean | null>(null);
  const set = (value: boolean) => {
    setPending(value);
    act('PATCH', '', { [field]: value })
      .then(() => toast(value ? names[0] : names[1]))
      .catch(() => {})
      .finally(() => setPending(null));
  };
  return { value: pending ?? checked, set };
}

function Item({ children }: { children: ReactNode }) {
  return <div className="rail-item">{children}</div>;
}

export function RoomRail({ state }: { state: RoomState | null }) {
  const { code, isHost, toast } = useRoom();
  const scoring = useHostField('scoring', Boolean(state?.scoring), ['Pontuação ligada.', 'Pontuação desligada.']);
  const voice = useHostField('voice', Boolean(state?.voice), ['Voz nas caixas ligada.', 'Voz nas caixas desligada.']);
  const fair = useHostField('fair', Boolean(state?.fair), ['Rodízio justo ligado.', 'Rodízio justo desligado.']);
  const [asking, setAsking] = useState(false);

  async function copyText(text: string, okMessage: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast(okMessage);
      return;
    } catch {
      // sem permissão da área de transferência (http fora de localhost): tenta o jeito antigo
    }
    const box = document.createElement('textarea');
    box.value = text;
    box.style.cssText = 'position:fixed;opacity:0;top:0;left:0';
    document.body.appendChild(box);
    box.select();
    let copied = false;
    try {
      copied = document.execCommand('copy');
    } finally {
      box.remove();
    }
    if (copied) toast(okMessage);
    else window.prompt('Copie o link:', text);
  }

  return (
    <aside className="room-rail" aria-label="Atalhos e ajustes da sala">
      <Item>
        <RailButton
          icon="link"
          label="Copiar link da sala"
          tip="Copiar o link da sala (quem abrir entra como convidado)"
          onClick={() => void copyText(`${location.origin}/room.html?room=${code}`, 'Link da sala copiado!')}
        />
      </Item>
      {isHost && !insideOwnerApp && (
        <Item>
          <RailButton icon="display" label="Abrir TV" tip="Abrir a TV da sala em outra aba" onClick={() => window.open(`tv.html?room=${code}`, '_blank')} />
        </Item>
      )}
      {isHost && (
        <Item>
          <RailButton
            icon="host"
            label="Copiar link de anfitrião"
            tip="Copiar o link de anfitrião: quem abrir controla a sala (use para administrar de outro aparelho)"
            onClick={() => void copyText(`${location.origin}/room.html?room=${code}#host=${hostToken(code)}`, 'Link de anfitrião copiado! Quem abrir controla a sala.')}
          />
        </Item>
      )}
      {isHost && (
        <>
          <span className="rail-sep" aria-hidden="true" />
          <Item>
            <RailSwitch icon="mic" label="Pontuação pelo microfone" tip="Pontuação pelo microfone: a TV compara a afinação de quem canta com a voz original (precisa de microfone na TV)" checked={scoring.value} onToggle={scoring.set} />
          </Item>
          <div className="rail-item has-pop">
            <RailSwitch
              icon="sound"
              label="Voz do microfone nas caixas de som"
              tip="Voz nas caixas: a voz de quem canta sai junto com a música (use microfones direcionais, para evitar a microfonia)"
              checked={voice.value}
              onToggle={(next) => (next ? setAsking(true) : voice.set(false))}
            />
            <div className="rail-pop">
              <VoiceVolume />
            </div>
          </div>
          <Item>
            <RailSwitch icon="shuffle" label="Rodízio justo" tip="Rodízio justo: a mesma pessoa não canta duas seguidas quando há outra esperando" checked={fair.value} onToggle={fair.set} />
          </Item>
        </>
      )}
      {asking && (
        <VoiceDialog
          onConfirm={() => {
            setAsking(false);
            voice.set(true);
          }}
          onCancel={() => setAsking(false)}
        />
      )}
    </aside>
  );
}
