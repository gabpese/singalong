// "Na fila": quem espera, na ordem em que vai tocar, com as ações de cada item.
import { api } from '../lib/identity.js';
import { keySummary } from '../lib/music.js';
import { canRetry, playOrder, songChip, thumbnailUrl } from '../lib/queue-view.js';
import type { ApiError, QueueItem, RoomState } from '../lib/types';
import { Icon } from '../ui/Icon';
import { useRoom } from './context';
import { BackingControl } from './BackingControl';
import { PitchControl } from './PitchControl';

const FAIR_HINT = 'Com o rodízio justo ligado a ordem é automática';

interface ItemProps {
  item: QueueItem;
  index: number;
  waiting: QueueItem[];
  state: RoomState;
  onPreview: (item: QueueItem) => void;
  onChooseLyrics: (item: QueueItem) => void;
}

function QueueRow({ item, index, waiting, state, onPreview, onChooseLyrics }: ItemProps) {
  const { act, isHost, toast, code } = useRoom();
  const chip = songChip(item.song);
  const run = (method: string, path: string, body?: unknown) => act(method, path, body).catch(() => {});
  const showError =
    item.song.status === 'needs_lyrics' || item.song.status === 'failed' || (item.song.stage === 'retrying' && item.song.error);

  async function retry() {
    try {
      await api('POST', '/api/songs', { url: `https://www.youtube.com/watch?v=${item.video_id}` }, code);
      toast('Tentando de novo…');
    } catch (err) {
      toast((err as ApiError).message, true);
    }
  }

  return (
    <li className={`queue-item${item.mine ? ' mine' : ''}`}>
      <span className="rank">{index + 1}</span>
      <img src={thumbnailUrl(item.video_id)} alt="" className="thumb" loading="lazy" />
      <div className="info">
        <strong>{item.title ?? item.video_id}</strong>
        <span className="muted">
          {item.artist ? `${item.artist} · ` : null}
          <Icon name="singing" />
          {` ${item.added_by}`}
        </span>
        {item.song.key && <span className="muted small">{keySummary(item.song.key, item.pitch)}</span>}
        <span className="chips">
          <span className={`chip ${chip.kind}`}>{chip.label}</span>
          {item.id === state.next_item_id && <span className="chip is-next">Próximo</span>}
        </span>
        {showError && <span className="muted small">{item.song.error ?? ''}</span>}
      </div>
      <div className="actions">
        {item.song.ready && (
          <button type="button" className="ghost" onClick={() => onPreview(item)}>
            Prévia
          </button>
        )}
        {item.song.status === 'needs_lyrics' && item.can_edit && (
          <button type="button" onClick={() => onChooseLyrics(item)}>
            Escolher letra
          </button>
        )}
        {canRetry(item.song) && item.can_edit && (
          <button type="button" onClick={retry}>
            Tentar de novo
          </button>
        )}
        <PitchControl item={item} />
        {isHost ? (
          <>
            <button
              type="button"
              aria-label="Subir na fila"
              disabled={state.fair || index === 0}
              title={state.fair ? FAIR_HINT : undefined}
              onClick={() => void run('POST', `/queue/${item.id}/move`, { direction: 'up' })}
            >
              ▲
            </button>
            <button
              type="button"
              aria-label="Descer na fila"
              disabled={state.fair || index === waiting.length - 1}
              title={state.fair ? FAIR_HINT : undefined}
              onClick={() => void run('POST', `/queue/${item.id}/move`, { direction: 'down' })}
            >
              ▼
            </button>
          </>
        ) : (
          // quem não é anfitrião pode adiar a PRÓPRIA música em uma posição (foi ao banheiro, quer esperar mais um pouco)
          item.mine && (
            <button
              type="button"
              className="ghost"
              title="Passa a sua música uma posição para trás: a pessoa de trás canta antes"
              disabled={state.fair || index === waiting.length - 1}
              onClick={() =>
                void act('POST', `/queue/${item.id}/move`, { direction: 'down' })
                  .then(() => toast('Você cedeu a vez: sua música desceu uma posição.'))
                  .catch(() => {})
              }
            >
              Ceder a vez
            </button>
          )
        )}
        {item.can_edit && (
          <button type="button" className="danger" aria-label="Remover da fila" onClick={() => void run('DELETE', `/queue/${item.id}`)}>
            ✕
          </button>
        )}
      </div>
      <BackingControl item={item} />
    </li>
  );
}

export function QueueList({
  state,
  onPreview,
  onChooseLyrics,
}: {
  state: RoomState;
  onPreview: (item: QueueItem) => void;
  onChooseLyrics: (item: QueueItem) => void;
}) {
  const { upcoming: waiting } = playOrder(state);
  return (
    <article className="card">
      <h2>
        Na fila <span className="count">{waiting.length ? `(${waiting.length})` : ''}</span>
      </h2>
      <ol className="queue">
        {waiting.map((item: QueueItem, index: number) => (
          <QueueRow key={item.id} item={item} index={index} waiting={waiting} state={state} onPreview={onPreview} onChooseLyrics={onChooseLyrics} />
        ))}
      </ol>
      <p className="hint empty" hidden={waiting.length > 0}>
        Ninguém na fila. Toque em <strong>Adicionar</strong> para escolher uma música.
      </p>
    </article>
  );
}

export function Scoreboard({ state }: { state: RoomState }) {
  return (
    <article className="card" hidden={!state.scoring && !state.scoreboard?.length}>
      <h2>Placar</h2>
      <ol className="scoreboard">
        {(state.scoreboard ?? []).map((row) => (
          <li key={row.id}>
            <strong>{row.name}</strong>
            <span className="muted">{` ${row.title ?? ''}`}</span>
            <b className="points">{String(row.score)}</b>
          </li>
        ))}
      </ol>
    </article>
  );
}
