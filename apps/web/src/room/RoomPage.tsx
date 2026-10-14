// Controle da sala (celular): fila, o que está tocando, adicionar músicas, prévia e ações de anfitrião.
import { type ComponentProps, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../i18n/index.js';
import { api, setUserName, userName } from '../lib/identity.js';
import { splitQueue } from '../lib/queue-view.js';
import { stageDismissed, stageItemFor } from '../lib/stage.js';
import type { LibrarySong, QueueItem, RoomState } from '../lib/types';
import { AddSong, type AddSongHandle } from './AddSong';
import { InviteBanner } from './Duet';
import { RoomProvider, type RoomContextValue, type Tab, useAct, useToast, type View } from './context';
import { Library } from './Library';
import { NowPlaying } from './NowPlaying';
import { NameDialog } from './NameDialog';
import { QueueList, Scoreboard } from './QueueList';
import { PreviewBar, usePreview } from './usePreview';
import { RoomRail } from './RoomRail';
import { TabBar, TopBar } from './TopBar';
import { ReactionLayer, useReactionLayer } from '../ui/ReactionLayer';
import { TvViewer } from './TvViewer';
import { useRoomConnection } from './useRoomConnection';

declare global {
  interface Window {
    room?: { readonly state: RoomState | null; preview: unknown; readonly previewPitch: number };
  }
}

export function RoomPage({ code }: { code: string }) {
  const reactions = useReactionLayer();
  const { state, setState, status, gone, position, lyrics, send } = useRoomConnection(code, reactions.push);
  const { toast, show } = useToast();
  const act = useAct(code, setState, show);
  const [tab, setTab] = useState<Tab>('queue');
  const [view, setView] = useState<View>(() => (new URLSearchParams(location.search).get('view') === 'tv' ? 'tv' : 'room'));
  const [name, setName] = useState<string>(() => userName());
  // o modal do nome só na chegada (quem apaga o campo depois, para digitar outro, não leva um modal na cara)
  const [askName, setAskName] = useState(() => !userName().trim());
  const [library, setLibrary] = useState<LibrarySong[]>([]);
  const addSong = useRef<AddSongHandle>(null);
  const preview = usePreview(state, act);

  const showTab = useCallback((next: Tab) => {
    setView('room'); // adicionar, ver a fila... sempre levam à sala
    setTab(next);
    window.scrollTo({ top: 0 });
  }, []);

  const loadLibrary = useCallback(async () => {
    try {
      setLibrary(await api('GET', '/api/songs', undefined, code)); // com a sala: o servidor junta o catálogo do computador do dono
    } catch {
      // sem a lista: a aba "Músicas" fica vazia até a próxima tentativa
    }
  }, [code]);
  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary]);

  /** Recarrega a biblioteca quando alguma música da fila termina de processar. */
  const readyKey = state
    ? state.queue
        .filter((item) => item.song.ready)
        .map((item) => item.video_id)
        .sort()
        .join(',')
    : '';
  const lastReadyKey = useRef('');
  useEffect(() => {
    if (readyKey === lastReadyKey.current) return;
    lastReadyKey.current = readyKey;
    void loadLibrary();
  }, [readyKey, loadLibrary]);

  const myName = name.trim() || t('room.someone');
  const context: RoomContextValue = useMemo(
    () => ({ code, state, isHost: Boolean(state?.me?.is_host), act, toast: show, myName, showTab, react: (kind) => send({ type: 'reaction', kind }) }),
    [code, state, act, show, myName, showTab, send],
  );

  useEffect(() => {
    document.title = `Singalong — Sala ${code}`;
  }, [code]);
  // o nome da pessoa vai para a sala (a lista de quem está aqui, usada nos convites de dueto); de novo quando ela o muda
  useEffect(() => {
    if (status === 'connected') send({ type: 'hello', name });
  }, [name, status, send]);
  // chegou a vez da minha música: o cantor vai da sala para o palco (e volta quando ela acaba)
  useEffect(() => {
    if (stageItemFor(state, (itemId: number) => stageDismissed(code, itemId)) !== null) location.replace(`/stage.html?room=${code}`);
  }, [state, code]);
  // gancho de diagnóstico (testes no navegador)
  useEffect(() => {
    window.room = { get state() { return state; }, preview: preview.player, get previewPitch() { return preview.pitch; } };
  });

  async function submitNew(song: Parameters<ComponentProps<typeof AddSong>['submitNew']>[0]) {
    const result = await act('POST', '/queue', { ...song, name: myName });
    void loadLibrary();
    showTab('queue');
    if (result.cached) return t('room.added.cached');
    if (result.deduped) return t('room.added.deduped');
    return t('room.added.new');
  }

  /** Música do Jukebox escolhida no aviso do painel de adicionar: entra na fila na hora (já está pronta). */
  async function addLibrarySong(song: LibrarySong) {
    await act('POST', '/queue', { video_id: song.video_id, name: myName, display_title: song.title ?? undefined });
    void loadLibrary();
    showTab('queue');
    return t('room.added.cached');
  }

  async function submitLyrics(videoId: string, body: Record<string, unknown>) {
    await api('PUT', `/api/songs/${videoId}/lyrics`, body, code);
    showTab('queue');
    return t('room.lyricsSent');
  }

  if (gone) {
    return (
      <RoomProvider value={context}>
        <main className="room-page">
          <h1>{t('room.gone.title')}</h1>
          <p>{t('room.gone.body', { code })}</p>
          <a href="/" className="button primary">
            {t('room.gone.create')}
          </a>
        </main>
        <p className={`toast${toast.show ? ' show' : ''}${toast.isError ? ' error' : ''}`} role="status">
          {toast.text}
        </p>
      </RoomProvider>
    );
  }

  return (
    <RoomProvider value={context}>
      <a className="skip-link" href="#conteudo">
        {t('a11y.skip')}
      </a>
      <TopBar state={state} status={status} view={view} onView={setView} />
      <p className="sr-only" role="status" aria-live="polite">
        {state && splitQueue(state).current
          ? t('a11y.nowSinging', { who: splitQueue(state).current!.singers, title: splitQueue(state).current!.title ?? '' })
          : ''}
      </p>
      {view === 'room' && <RoomRail state={state} />}
      <InviteBanner />

      {view === 'tv' && (
        <main className="room-page" id="conteudo" tabIndex={-1}>
          <TvViewer state={state} position={position} lyrics={lyrics} />
          <ReactionLayer items={reactions.items} />
        </main>
      )}

      <main className="room-page" id={view === 'room' ? 'conteudo' : undefined} tabIndex={-1} hidden={view !== 'room'}>
        <section className="tab" hidden={tab !== 'queue'}>
          {state && (
            <>
              <NowPlaying state={state} position={position} />
              <QueueList
                state={state}
                onPreview={(item: QueueItem) => void preview.open(item)}
                onChooseLyrics={(item: QueueItem) => addSong.current?.chooseLyrics(item.video_id, item.song.error, { artist: item.artist, title: item.title })}
              />
              <Scoreboard state={state} />
            </>
          )}
        </section>

        <section className="tab" hidden={tab !== 'add'}>
          <AddSong
            ref={addSong}
            room={code}
            userName={name}
            onUserName={(value) => {
              setName(value);
              setUserName(value);
            }}
            onShow={() => showTab('add')}
            submitNew={submitNew}
            submitLyrics={submitLyrics}
            jukebox={library}
            onPickJukebox={addLibrarySong}
          />
        </section>

        <section className="tab" hidden={tab !== 'library'}>
          <Library songs={library} />
        </section>
      </main>

      {askName && (
        <NameDialog
          code={code}
          onName={(value) => {
            setName(value);
            setUserName(value);
            setAskName(false);
          }}
        />
      )}
      <PreviewBar preview={preview} />
      <TabBar tab={tab} onTab={showTab} queueCount={state?.queue.length ?? 0} hidden={view !== 'room'} />
      <p className={`toast${toast.show ? ' show' : ''}${toast.isError ? ' error' : ''}`} role="status">
        {toast.text}
      </p>
    </RoomProvider>
  );
}
