// "Na fila": quem espera, na ordem em que vai tocar, com as ações de cada item.
import { t } from '../i18n/index.js';
import { tRich } from '../i18n/rich';
import { api } from '../lib/identity.js';
import { keySummary } from '../lib/music.js';
import { canRetry, playOrder, songChip, thumbnailUrl } from '../lib/queue-view.js';
import type { ApiError, QueueItem, RoomState } from '../lib/types';
import { Icon } from '../ui/Icon';
import { useRoom } from './context';
import { BackingControl, GuideControl } from './BackingControl';
import { DuetControl } from './Duet';
import { PitchControl } from './PitchControl';

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
  const fairHint = t('queue.fairHint');
  const chip = songChip(item.song);
  const run = (method: string, path: string, body?: unknown) => act(method, path, body).catch(() => {});
  const showError =
    item.song.status === 'needs_lyrics' || item.song.status === 'failed' || (item.song.stage === 'retrying' && item.song.error);

  async function retry() {
    try {
      await api('POST', '/api/songs', { url: `https://www.youtube.com/watch?v=${item.video_id}` }, code);
      toast(t('queue.retryToast'));
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
          {` ${item.singers}`}
        </span>
        {item.song.key && <span className="muted small">{keySummary(item.song.key, item.pitch)}</span>}
        <span className="chips">
          <span className={`chip ${chip.kind}`}>{chip.label}</span>
          {item.id === state.next_item_id && <span className="chip is-next">{t('tv.next')}</span>}
        </span>
        {showError && <span className="muted small">{item.song.error ?? ''}</span>}
      </div>
      <div className="actions">
        {item.song.ready && !item.song.media?.local && (
          <button type="button" className="ghost" onClick={() => onPreview(item)}>
            {t('queue.preview')}
          </button>
        )}
        {item.song.status === 'needs_lyrics' && item.can_edit && (
          <button type="button" onClick={() => onChooseLyrics(item)}>
            {t('queue.chooseLyrics')}
          </button>
        )}
        {canRetry(item.song) && item.can_edit && (
          <button type="button" onClick={retry}>
            {t('queue.retry')}
          </button>
        )}
        <PitchControl item={item} />
        {isHost ? (
          <>
            <button
              type="button"
              aria-label={t('queue.up')}
              disabled={state.fair || index === 0}
              title={state.fair ? fairHint : undefined}
              onClick={() => void run('POST', `/queue/${item.id}/move`, { direction: 'up' })}
            >
              ▲
            </button>
            <button
              type="button"
              aria-label={t('queue.down')}
              disabled={state.fair || index === waiting.length - 1}
              title={state.fair ? fairHint : undefined}
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
              title={t('queue.yieldTitle')}
              disabled={state.fair || index === waiting.length - 1}
              onClick={() =>
                void act('POST', `/queue/${item.id}/move`, { direction: 'down' })
                  .then(() => toast(t('queue.yielded')))
                  .catch(() => {})
              }
            >
              {t('queue.yield')}
            </button>
          )
        )}
        {item.can_edit && (
          <button type="button" className="danger" aria-label={t('queue.remove')} onClick={() => void run('DELETE', `/queue/${item.id}`)}>
            ✕
          </button>
        )}
      </div>
      <BackingControl item={item} />
      <GuideControl item={item} />
      <DuetControl item={item} />
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
        {t('queue.heading')} <span className="count">{waiting.length ? `(${waiting.length})` : ''}</span>
      </h2>
      <ol className="queue">
        {waiting.map((item: QueueItem, index: number) => (
          <QueueRow key={item.id} item={item} index={index} waiting={waiting} state={state} onPreview={onPreview} onChooseLyrics={onChooseLyrics} />
        ))}
      </ol>
      <p className="hint empty" hidden={waiting.length > 0}>
        {tRich('queue.empty')}
      </p>
    </article>
  );
}

export function Scoreboard({ state }: { state: RoomState }) {
  return (
    <article className="card" hidden={!state.scoring && !state.scoreboard?.length}>
      <h2>{t('score.title')}</h2>
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
