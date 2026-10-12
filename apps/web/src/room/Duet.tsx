// Dueto: convidar alguém da sala para cantar junto, responder a um convite e ver com quem a música vai ser cantada.
import { useEffect, useRef, useState } from 'react';
import type { QueueItem } from '../lib/types';
import { useRoom } from './context';

/** Quem está na sala agora (menos eu), para escolher o convidado. */
function InviteDialog({ item, onClose }: { item: QueueItem; onClose: () => void }) {
  const { act, state, toast } = useRoom();
  const dialog = useRef<HTMLDialogElement>(null);
  const others = (state?.people ?? []).filter((person) => person.pid !== state?.me.pid);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);

  async function invite(pid: string, name: string) {
    setBusy(true);
    try {
      await act('POST', `/queue/${item.id}/invite`, { pid });
      toast(`Convite enviado para ${name}. Quando aceitar, vocês cantam juntos.`);
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
        <h2 id="duet-title">Cantar junto com quem?</h2>
        <p className="muted">
          Escolha alguém que está na sala agora. A pessoa recebe o convite no celular e precisa aceitar. Na vez da música, os dois vão para o palco.
        </p>
        {others.length === 0 ? (
          <p className="hint">Ninguém mais está na sala agora. Peça para a pessoa entrar pelo código da sala e tente de novo.</p>
        ) : (
          <ul className="people">
            {others.map((person) => (
              <li key={person.pid}>
                <button type="button" disabled={busy} onClick={() => void invite(person.pid, person.name)}>
                  {person.name}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="jukebox-actions">
          <button type="button" onClick={onClose}>
            Fechar
          </button>
        </div>
      </div>
    </dialog>
  );
}

/** Na linha da música da fila: convidar, ver o convite enviado ou o dueto confirmado. */
export function DuetControl({ item }: { item: QueueItem }) {
  const { act } = useRoom();
  const [choosing, setChoosing] = useState(false);
  const cancel = () => void act('DELETE', `/queue/${item.id}/invite`).catch(() => {});

  if (item.guest_me) return <p className="duet-note ok">{`Dueto com ${item.added_by} ✓`}</p>;
  if (!item.can_edit) {
    return item.guest?.status === 'accepted' ? <p className="duet-note">{`Dueto com ${item.guest.name}`}</p> : null;
  }
  return (
    <div className="duet-row">
      {item.guest?.status === 'accepted' && <span className="duet-note ok">{`Dueto com ${item.guest.name} ✓`}</span>}
      {item.guest?.status === 'pending' && <span className="duet-note">{`Convite enviado para ${item.guest.name}, aguardando…`}</span>}
      {item.guest ? (
        <button type="button" className="ghost" onClick={cancel}>
          {item.guest.status === 'accepted' ? 'Tirar o dueto' : 'Cancelar o convite'}
        </button>
      ) : (
        <button type="button" className="ghost" onClick={() => setChoosing(true)}>
          Convidar para cantar junto
        </button>
      )}
      {choosing && <InviteDialog item={item} onClose={() => setChoosing(false)} />}
    </div>
  );
}

/** Convites que recebi: aceitar (vou ao palco com a pessoa na vez da música) ou recusar. */
export function InviteBanner() {
  const { act, state } = useRoom();
  const invites = (state?.queue ?? []).filter((item) => item.invite_for_me);
  if (invites.length === 0) return null;
  return (
    <section className="invites" aria-label="Convites para cantar junto">
      {invites.map((item) => (
        <article key={item.id} className="card invite">
          <p>
            <strong>{item.added_by}</strong> convidou você para cantar <strong>{item.title ?? 'uma música'}</strong> em dupla.
          </p>
          <div className="invite-actions">
            <button type="button" className="primary" onClick={() => void act('POST', `/queue/${item.id}/invite/respond`, { accept: true }).catch(() => {})}>
              Aceitar
            </button>
            <button type="button" onClick={() => void act('POST', `/queue/${item.id}/invite/respond`, { accept: false }).catch(() => {})}>
              Recusar
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}
