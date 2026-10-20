// Dueto: convidar alguém da sala para cantar junto, responder a um convite e ver com quem a música vai ser cantada.
// Os componentes de convite e de aviso não dependem do contexto da sala: servem à sala, ao palco e à TV.
import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n/index.ts';
import { tRich } from '../i18n/rich';
import { api } from '../lib/identity.ts';
import type { ApiError, QueueItem, RoomState } from '../lib/types.ts';
import { PartsDialog } from './PartsDialog';
import { useRoom } from './context';

type Person = { pid: string; name: string };

/** Quem está na sala agora (menos eu), para escolher o convidado. */
export function InviteDialog({ people, mePid, onInvite, onClose }: { people: Person[]; mePid: string | null; onInvite: (person: Person) => Promise<void>; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const others = people.filter((person) => person.pid !== mePid);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);

  async function choose(person: Person) {
    setBusy(true);
    try {
      await onInvite(person);
      onClose();
    } catch {
      setBusy(false); // o erro já foi avisado
    }
  }

  return (
    <dialog
      ref={dialog}
      className="jukebox-dialog"
      aria-labelledby="duet-title"
      onClose={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="jukebox-body">
        <h2 id="duet-title">{t('duet.pickTitle')}</h2>
        <p className="muted">
          {t('duet.pickHint')}
        </p>
        {others.length === 0 ? (
          <p className="hint">{t('duet.nobody')}</p>
        ) : (
          <ul className="people">
            {others.map((person) => (
              <li key={person.pid}>
                <button type="button" disabled={busy} onClick={() => void choose(person)}>
                  {person.name}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="jukebox-actions">
          <button type="button" onClick={onClose}>
            {t('duet.close')}
          </button>
        </div>
      </div>
    </dialog>
  );
}

/** Na linha da música (da fila ou da que está tocando): convidar, ver o convite enviado ou o dueto confirmado. */
export function DuetControl({ item }: { item: QueueItem }) {
  const { act, state, toast } = useRoom();
  const [choosing, setChoosing] = useState(false);
  const [splitting, setSplitting] = useState(false);
  const cancel = () => void act('DELETE', `/queue/${item.id}/invite`).catch(() => {});

  const partsButton = item.guest?.status === 'accepted' && (item.can_edit || item.guest_me) && (
    <>
      <button type="button" className="ghost" onClick={() => setSplitting(true)}>
        {t('parts.button')}
      </button>
      {splitting && <PartsDialog item={item} onClose={() => setSplitting(false)} />}
    </>
  );
  if (item.guest_me) {
    return (
      <div className="duet-row">
        <span className="duet-note ok">{t('duet.withOk', { name: item.added_by })}</span>
        {partsButton}
      </div>
    );
  }
  if (!item.can_edit) {
    return item.guest?.status === 'accepted' ? <p className="duet-note">{t('duet.with', { name: item.guest.name })}</p> : null;
  }
  return (
    <div className="duet-row">
      {item.guest?.status === 'accepted' && <span className="duet-note ok">{t('duet.withOk', { name: item.guest.name })}</span>}
      {item.guest?.status === 'pending' && <span className="duet-note">{t('duet.pending', { name: item.guest.name })}</span>}
      {partsButton}
      {item.guest ? (
        <button type="button" className="ghost" onClick={cancel}>
          {t(item.guest.status === 'accepted' ? 'duet.remove' : 'duet.cancelInvite')}
        </button>
      ) : (
        <button type="button" className="ghost" onClick={() => setChoosing(true)}>
          {t('duet.invite')}
        </button>
      )}
      {choosing && (
        <InviteDialog
          people={state?.people ?? []}
          mePid={state?.me.pid ?? null}
          onClose={() => setChoosing(false)}
          onInvite={async (person) => {
            await act('POST', `/queue/${item.id}/invite`, { pid: person.pid });
            toast(t('duet.sent', { name: person.name }));
          }}
        />
      )}
    </div>
  );
}

/**
 * O aviso de convite, na tela em que a pessoa estiver (fila, adicionar, Jukebox, palco, TV): aceitar ou recusar. É só a tela:
 * quem chama diz o que fazer com a resposta.
 */
export function InviteNotice({ state, onRespond }: { state: RoomState | null; onRespond: (item: QueueItem, accept: boolean) => void }) {
  const invites = (state?.queue ?? []).filter((item) => item.invite_for_me);
  const seen = useRef(0);
  // um convite novo faz o celular vibrar (quando o aparelho deixa), para a pessoa perceber mesmo olhando outra coisa
  useEffect(() => {
    if (invites.length > seen.current) navigator.vibrate?.([200, 100, 200]);
    seen.current = invites.length;
  }, [invites.length]);
  if (invites.length === 0) return null;
  return (
    <section className="invites" role="alert" aria-label={t('duet.invitesAria')}>
      {invites.map((item) => (
        <article key={item.id} className="card invite">
          <p>
            {tRich('duet.inviteText', {
              who: item.added_by,
              song: item.title ?? t('duet.songFallback'),
              playing: item.status === 'playing' ? t('duet.playingNow') : '',
            })}
          </p>
          <div className="invite-actions">
            <button type="button" className="primary" onClick={() => onRespond(item, true)}>
              {t('duet.accept')}
            </button>
            <button type="button" onClick={() => onRespond(item, false)}>
              {t('duet.decline')}
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}

/** Responde a um convite fora do contexto da sala (palco e TV): chama a API; o estado novo chega pelo WebSocket. */
export async function respondInvite(code: string, item: QueueItem, accept: boolean): Promise<void> {
  try {
    await api('POST', `/api/rooms/${code}/queue/${item.id}/invite/respond`, { accept }, code);
  } catch (err) {
    console.warn('convite:', (err as ApiError).message);
  }
}

/** O aviso na sala: dentro do contexto, com as ações da própria sala. */
export function InviteBanner() {
  const { act, state } = useRoom();
  return (
    <InviteNotice
      state={state}
      onRespond={(item, accept) => void act('POST', `/queue/${item.id}/invite/respond`, { accept }).catch(() => {})}
    />
  );
}
