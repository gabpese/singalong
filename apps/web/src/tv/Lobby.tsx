// A sala de espera da TV, um cartaz colado na parede: o QR code no centro, o código da sala e, embaixo, um bichinho (blobatar) para cada
// celular que entrou. A lista chega pelo WebSocket da sala e muda em tempo real; vagas livres completam a fileira.
// O blobatar sai do nome da pessoa (o mesmo nome dá sempre o mesmo bichinho) e é desenhado aqui, sem chamar nenhum servidor.
import { Blobatar } from '@blobatar/react';
import 'blobatar/motion.css';
import { t } from '../i18n/index.ts';
import { tRich } from '../i18n/rich';
import type { RoomState } from '../lib/types.ts';
import { Logo } from '../ui/Logo';
import { QrCode } from './QrCode';

/** Lugares desenhados: pelo menos 4 (vagas livres enquanto pouca gente entrou) e no máximo 7, que é o que cabe numa fileira do cartaz.
 * Não é limite da sala (o servidor não limita quantos celulares entram): passando de 7, o último lugar vira "+N". */
const MIN_SLOTS = 4;
const MAX_SLOTS = 7;

function countText(n: number): string {
  return t(n === 0 ? 'tvp.lobbyCount.zero' : n === 1 ? 'tvp.lobbyCount.one' : 'tvp.lobbyCount.many', { n });
}

export function Lobby({ code, people, status }: { code: string; people: RoomState['people']; status: string }) {
  const overflow = people.length > MAX_SLOTS;
  const shown = overflow ? people.slice(0, MAX_SLOTS - 1) : people;
  const free = Math.max(0, MIN_SLOTS - people.length);
  return (
    <div className="lobby">
      <i className="tape" aria-hidden="true" />
      <i className="tape r" aria-hidden="true" />
      <div className="lobby-sheet">
        <i className="dots" aria-hidden="true" />
        <p className="lobby-brand">
          <Logo onPaper />
        </p>
        <h1 className="lobby-title">{t('tvp.lobbyTitle')}</h1>
        <p className="idle-lead">{tRich('tvp.idleLead', { code })}</p>
        <div className="lobby-qr">
          <QrCode code={code} />
        </div>
        <p className="lobby-scan">{t('tvp.lobbyScan')}</p>
        <div className="lobby-code" aria-label={t('tvp.lobbyCode')}>
          <small>{t('tvp.lobbyCode')}</small>
          <strong className="display">{code}</strong>
        </div>
        <section className="lobby-players" aria-label={t('tvp.lobbyPlayers')}>
          <p className="lobby-count" aria-live="polite">
            <span className="live-dot" aria-hidden="true" /> {countText(people.length)}
          </p>
          <ul className="lobby-slots">
            {shown.map((person) => (
              <li key={person.pid} className="slot filled">
                <Blobatar name={person.name} background={false} animate="always" className="blob" aria-hidden="true" />
                <span className="slot-name">{person.name}</span>
              </li>
            ))}
            {overflow && (
              <li className="slot more">
                <span className="avatar-more" aria-hidden="true">
                  +{people.length - shown.length}
                </span>
                <span className="slot-name">{t('tvp.lobbyMore', { n: people.length - shown.length })}</span>
              </li>
            )}
            {Array.from({ length: free }, (_, index) => (
              <li key={`free-${index}`} className="slot free">
                <span className="avatar-empty" aria-hidden="true" />
                <span className="slot-name">{t('tvp.lobbyEmpty')}</span>
              </li>
            ))}
          </ul>
        </section>
        <p className="idle-msg">{status}</p>
      </div>
    </div>
  );
}
