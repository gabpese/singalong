// Duet: inviting someone in the Room to sing along, answering an invitation and seeing who the song will be sung with.
// The invitation and notice components do not depend on the Room's context: they serve the Room, the Stage and the TV.
import { useEffect, useRef, useState } from 'react';
import { t } from '../i18n/index.ts';
import { tRich } from '../i18n/rich';
import { api } from '../lib/identity.ts';
import type { ApiError, QueueItem, RoomState } from '../lib/types.ts';
import { PartsDialog } from './PartsDialog';
import { useRoom } from './context';

type Person = { pid: string; name: string };

/** Who is in the Room now (except me), to choose the invited partner. */
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
      setBusy(false); // the error was already shown
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

/** On the song's row (in the Queue or the one playing): invite, see the invitation sent or the confirmed duet. */
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
 * The invitation notice, on whatever screen the person is on (Queue, add, Jukebox, Stage, TV): accept or decline. It is only the screen:
 * the caller says what to do with the answer.
 */
export function InviteNotice({ state, onRespond }: { state: RoomState | null; onRespond: (item: QueueItem, accept: boolean) => void }) {
  const invites = (state?.queue ?? []).filter((item) => item.invite_for_me);
  const seen = useRef(0);
  // a new invitation makes the phone vibrate (when the device allows it), so the person notices even while looking at something else
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

/** Answers an invitation outside the Room's context (Stage and TV): calls the API; the new state arrives through the WebSocket. */
export async function respondInvite(code: string, item: QueueItem, accept: boolean): Promise<void> {
  try {
    await api('POST', `/api/rooms/${code}/queue/${item.id}/invite/respond`, { accept }, code);
  } catch (err) {
    console.warn('convite:', (err as ApiError).message);
  }
}

/** The notice in the Room: inside the context, with the Room's own actions. */
export function InviteBanner() {
  const { act, state } = useRoom();
  return (
    <InviteNotice
      state={state}
      onRespond={(item, accept) => void act('POST', `/queue/${item.id}/invite/respond`, { accept }).catch(() => {})}
    />
  );
}
