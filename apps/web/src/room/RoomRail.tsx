// The Room's side rail: the shortcuts and the Host's settings always in view, as icons only (the text goes in the tooltip and the
// accessible name). On wide screens it is a column on the left; on the phone it becomes a strip right below the top bar.
import { t } from '../i18n/index.ts';
import { type ReactNode, useState } from 'react';
import { hostToken } from '../lib/identity.ts';
import type { RoomState } from '../lib/types.ts';
import { Icon, type IconName } from '../ui/Icon';
import { useRoom } from './context';
import { VoiceDialog, VoiceVolume } from './VoiceControl';

/** The Owner's app already has the TV and Host tabs: "Abrir TV" makes no sense there. */
const insideOwnerApp = typeof navigator !== 'undefined' && navigator.userAgent.includes('Electron');

/** An action button (copy, open): only the icon; the text shows on hover or focus. */
function RailButton({ icon, label, tip, onClick }: { icon: IconName; label: string; tip: string; onClick: () => void }) {
  return (
    <button type="button" className="rail-btn" aria-label={label} data-tip={tip} onClick={onClick}>
      <Icon name={icon} />
    </button>
  );
}

/** An on/off setting (a switch): the click takes effect at once and is undone only if the server refuses it. */
function RailSwitch({ icon, label, tip, checked, onToggle, beta = false }: { icon: IconName; label: string; tip: string; checked: boolean; onToggle: (next: boolean) => void; beta?: boolean }) {
  return (
    <button type="button" role="switch" aria-checked={checked} aria-label={beta ? `${label} (${t('beta.tag')})` : label} data-tip={beta ? `${tip}. ${t('beta.note')}` : tip} className={`rail-switch${checked ? ' on' : ''}`} onClick={() => onToggle(!checked)}>
      <Icon name={icon} />
      {beta && <span className="beta-dot" aria-hidden="true">{t('beta.tag')}</span>}
      <span className="sw" aria-hidden="true" />
    </button>
  );
}

/** A Host setting that goes in the Room's PATCH. */
function useHostField(field: 'fair' | 'scoring' | 'voice' | 'melody_bars' | 'intermission', checked: boolean, names: [string, string]) {
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
  const scoring = useHostField('scoring', Boolean(state?.scoring), [t('rail.scoringOn'), t('rail.scoringOff')]);
  const voice = useHostField('voice', Boolean(state?.voice), [t('rail.voiceOn'), t('rail.voiceOff')]);
  const melody = useHostField('melody_bars', Boolean(state?.melody_bars), [t('rail.melodyOn'), t('rail.melodyOff')]);
  const fair = useHostField('fair', Boolean(state?.fair), [t('rail.fairOn'), t('rail.fairOff')]);
  const intermission = useHostField('intermission', Boolean(state?.intermission), [t('rail.intermissionOn'), t('rail.intermissionOff')]);
  const [asking, setAsking] = useState(false);

  async function copyText(text: string, okMessage: string) {
    try {
      await navigator.clipboard.writeText(text);
      toast(okMessage);
      return;
    } catch {
      // no clipboard permission (http outside localhost): tries the old way
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
    else window.prompt(t('rail.prompt'), text);
  }

  return (
    <aside className="room-rail" aria-label={t('rail.aria')}>
      <Item>
        <RailButton
          icon="link"
          label={t('rail.copyRoom')}
          tip={t('rail.copyRoomTip')}
          onClick={() => void copyText(`${location.origin}/room.html?room=${code}`, t('rail.copiedRoom'))}
        />
      </Item>
      {isHost && !insideOwnerApp && (
        <Item>
          <RailButton icon="display" label={t('rail.openTv')} tip={t('rail.openTvTip')} onClick={() => window.open(`tv.html?room=${code}`, '_blank')} />
        </Item>
      )}
      {isHost && (
        <Item>
          <RailButton
            icon="host"
            label={t('rail.copyHost')}
            tip={t('rail.copyHostTip')}
            onClick={() => void copyText(`${location.origin}/room.html?room=${code}#host=${hostToken(code)}`, t('rail.copiedHost'))}
          />
        </Item>
      )}
      {isHost && (
        <>
          <span className="rail-sep" aria-hidden="true" />
          <Item>
            <RailSwitch icon="mic" label={t('rail.scoring')} tip={t('rail.scoringTip')} checked={scoring.value} onToggle={scoring.set} beta />
          </Item>
          <div className={`rail-item has-pop${voice.value ? ' voice-on' : ''}`}>
            <RailSwitch
              icon="sound"
              label={t('rail.voice')}
              tip={t('rail.voiceTip')}
              checked={voice.value}
              onToggle={(next) => (next ? setAsking(true) : voice.set(false))}
            />
            <div className="rail-pop">
              {/* with the voice on, the bubble joins the switch's explanation and the volume (a separate tip would cover the volume) */}
              {voice.value && <p className="pop-tip">{t('rail.voiceTip')}</p>}
              <VoiceVolume />
            </div>
          </div>
          <Item>
            <RailSwitch icon="melody" label={t('rail.melody')} tip={t('rail.melodyTip')} checked={melody.value} onToggle={melody.set} beta />
          </Item>
          <Item>
            <RailSwitch icon="shuffle" label={t('rail.fair')} tip={t('rail.fairTip')} checked={fair.value} onToggle={fair.set} />
          </Item>
          <Item>
            <RailSwitch icon="stage" label={t('rail.intermission')} tip={t('rail.intermissionTip')} checked={intermission.value} onToggle={intermission.set} />
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
