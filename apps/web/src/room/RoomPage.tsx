// Controle da sala (celular): fila, o que está tocando, adicionar músicas, prévia e ações de anfitrião.
import { type ComponentProps, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, setUserName, userName } from '../lib/identity.js';
import type { LibrarySong, QueueItem, RoomState } from '../lib/types';
import { AddSong, type AddSongHandle } from './AddSong';
import { RoomProvider, type RoomContextValue, type Tab, useAct, useToast } from './context';
import { Library } from './Library';
import { NowPlaying } from './NowPlaying';
import { QueueList, Scoreboard } from './QueueList';
import { PreviewBar, usePreview } from './usePreview';
import { TabBar, TopBar } from './TopBar';
import { useRoomConnection } from './useRoomConnection';

declare global {
  interface Window {
    room?: { readonly state: RoomState | null; preview: unknown; readonly previewPitch: number };
  }
}

export function RoomPage({ code }: { code: string }) {
  const { state, setState, status, gone, position } = useRoomConnection(code);
  const { toast, show } = useToast();
  const act = useAct(code, setState, show);
  const [tab, setTab] = useState<Tab>('queue');
  const [name, setName] = useState<string>(() => userName());
  const [library, setLibrary] = useState<LibrarySong[]>([]);
  const addSong = useRef<AddSongHandle>(null);
  const preview = usePreview(state, act);

  const showTab = useCallback((next: Tab) => {
    setTab(next);
    window.scrollTo({ top: 0 });
  }, []);

  const loadLibrary = useCallback(async () => {
    try {
      setLibrary(await api('GET', '/api/songs'));
    } catch {
      // sem a lista: a aba "Músicas" fica vazia até a próxima tentativa
    }
  }, []);
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

  const myName = name.trim() || 'Alguém';
  const context: RoomContextValue = useMemo(
    () => ({ code, state, isHost: Boolean(state?.me?.is_host), act, toast: show, myName, showTab }),
    [code, state, act, show, myName, showTab],
  );

  useEffect(() => {
    document.title = `Singalong — Sala ${code}`;
  }, [code]);
  // gancho de diagnóstico (testes no navegador)
  useEffect(() => {
    window.room = { get state() { return state; }, preview: preview.player, get previewPitch() { return preview.pitch; } };
  });

  async function submitNew(song: Parameters<ComponentProps<typeof AddSong>['submitNew']>[0]) {
    const result = await act('POST', '/queue', { ...song, name: myName });
    void loadLibrary();
    showTab('queue');
    if (result.cached) return 'Adicionada à fila (essa música já estava pronta).';
    if (result.deduped) return 'Adicionada à fila (essa música já estava sendo preparada).';
    return 'Adicionada à fila! Ela está sendo preparada e toca quando chegar a vez.';
  }

  /** Música do Jukebox escolhida no aviso do painel de adicionar: entra na fila na hora (já está pronta). */
  async function addLibrarySong(song: LibrarySong) {
    await act('POST', '/queue', { video_id: song.video_id, name: myName, display_title: song.title ?? undefined });
    void loadLibrary();
    showTab('queue');
    return 'Adicionada à fila (essa música já estava pronta).';
  }

  async function submitLyrics(videoId: string, body: Record<string, unknown>) {
    await api('PUT', `/api/songs/${videoId}/lyrics`, body, code);
    showTab('queue');
    return 'Letra enviada. A música volta a ser preparada.';
  }

  if (gone) {
    return (
      <RoomProvider value={context}>
        <main className="room-page">
          <h1>Sala não encontrada</h1>
          <p>{`A sala ${code} não existe mais (salas paradas há 24 horas são apagadas).`}</p>
          <a href="/" className="button primary">
            Criar uma nova sala
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
      <TopBar state={state} status={status} />

      <main className="room-page">
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

      <PreviewBar preview={preview} />
      <TabBar tab={tab} onTab={showTab} queueCount={state?.queue.length ?? 0} hidden={false} />
      <p className={`toast${toast.show ? ' show' : ''}${toast.isError ? ' error' : ''}`} role="status">
        {toast.text}
      </p>
    </RoomProvider>
  );
}
