// Dueto: convidar alguém da sala para cantar junto, responder a um convite e ver com quem a música vai ser cantada.
// Os componentes de convite e de aviso não dependem do contexto da sala: servem à sala, ao palco e à TV.
import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/identity.js';
import type { ApiError, QueueItem, RoomState } from '../lib/types';
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
        <h2 id="duet-title">Cantar junto com quem?</h2>
        <p className="muted">
          Escolha alguém que está na sala agora. A pessoa recebe o convite no celular, em qualquer tela, e precisa aceitar. Se a música já estiver tocando, quem
          aceitar entra no dueto na hora.
        </p>
        {others.length === 0 ? (
          <p className="hint">Ninguém mais está na sala agora. Peça para a pessoa entrar pelo código da sala e tente de novo.</p>
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
            Fechar
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
      {choosing && (
        <InviteDialog
          people={state?.people ?? []}
          mePid={state?.me.pid ?? null}
          onClose={() => setChoosing(false)}
          onInvite={async (person) => {
            await act('POST', `/queue/${item.id}/invite`, { pid: person.pid });
            toast(`Convite enviado para ${person.name}. Quando aceitar, vocês cantam juntos.`);
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
    <section className="invites" role="alert" aria-label="Convites para cantar junto">
      {invites.map((item) => (
        <article key={item.id} className="card invite">
          <p>
            <strong>{item.added_by}</strong> convidou você para cantar <strong>{item.title ?? 'uma música'}</strong> em dupla
            {item.status === 'playing' ? ' (ela já está tocando)' : ''}.
          </p>
          <div className="invite-actions">
            <button type="button" className="primary" onClick={() => onRespond(item, true)}>
              Aceitar
            </button>
            <button type="button" onClick={() => onRespond(item, false)}>
              Recusar
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
