// Controlador da TV: liga a sala (WebSocket) ao motor de áudio e à pontuação. Não desenha nada: avisa a tela pelo `ui`.
// A TV toca o que a sala manda (a fila é do servidor), avisa quando a música termina e a posição para os celulares.
import { t } from '../i18n/index.js';
import { createEngine } from '../lib/engine.js';
import { clampLatency, loadLatency, saveLatency, sungPosition } from '../lib/latency.js';
import { loadMics, micsKey, openVoice, saveMics, voiceGain } from '../lib/voice.js';
import { connectRoom } from '../lib/identity.js';
import { splitQueue } from '../lib/queue-view.js';
import { createScorer, noteName, openMic } from '../lib/scoring.js';
import { finalMessage, MIN_SCORED_FRAMES } from '../lib/score-view.js';
import type { QueueItem, RoomState, ServerMessage } from '../lib/types';

export interface HudState {
  visible: boolean;
  score: number;
  /** Mensagem no lugar das notas (sem melodia, microfone negado...); vazia = mostrar "Original/Você". */
  notice: string;
  original: string;
  sung: string;
}

export interface FinalResult {
  score: number;
  singer: string;
  message: string;
}

export interface TvUi {
  setRoom(state: RoomState): void;
  /** Aviso no rodapé; `ms` > 0 some depois desse tempo. */
  notify(text: string, ms?: number): void;
  setUnlock(show: boolean): void;
  setHud(hud: HudState): void;
  setProgress(percent: number): void;
  /** Resultado da música que acabou de terminar (some depois de 9 s). */
  setFinal(result: FinalResult | null): void;
}

type Connection = { send(payload: unknown): void; close(): void };

const FINAL_SECONDS = 9;

export function createTvController(code: string, ui: TvUi, lyricsEls: { prev: HTMLElement; current: HTMLElement; next: HTMLElement; next2: HTMLElement }) {
  let latest: RoomState | null = null; // último estado da sala
  let latency = loadLatency(); // atraso do som e do microfone deste aparelho (veja lib/latency.js)
  let micsChosen = loadMics(); // microfones escolhidos nesta TV (vazio = o padrão); o primeiro também serve à pontuação
  let applying = false;
  let endedFor: number | null = null; // evita avisar duas vezes que a mesma música terminou
  let resumed = false; // só a primeira música carregada depois de abrir a página retoma de uma posição anterior
  let noticeTimer: ReturnType<typeof setTimeout> | undefined;
  let finalTimer: ReturnType<typeof setTimeout> | undefined;

  // pontuação pelo microfone (só quando o anfitrião liga e a música tem a melodia de referência)
  let mic: Awaited<ReturnType<typeof openMic>> | null = null;
  let micFailed = false;
  let scorer: ReturnType<typeof createScorer> | null = null;
  let scorerFor: number | null = null; // item que o `scorer` acompanha
  let hud: HudState = { visible: false, score: 0, notice: '', original: '', sung: '' };
  let shownNotes = '';

  const notify = (text: string, ms = 0) => {
    clearTimeout(noticeTimer);
    ui.notify(text);
    if (ms) noticeTimer = setTimeout(() => ui.notify(''), ms);
  };

  function setHud(patch: Partial<HudState>) {
    const next = { ...hud, ...patch };
    if ((Object.keys(next) as (keyof HudState)[]).every((key) => next[key] === hud[key])) return; // nada mudou: não redesenha
    hud = next;
    ui.setHud(hud);
  }

  const engine = createEngine({
    lyricsEls,
    onEnded(itemId: number) {
      if (endedFor === itemId) return;
      endedFor = itemId;
      reportScore(itemId);
      connection.send({ type: 'ended', item_id: itemId });
    },
    // a letra também vai para o palco dos cantores (no celular): com as músicas no computador do dono, só a TV a alcança
    onLyrics(itemId: number, cues: unknown[]) {
      connection.send({ type: 'lyrics', item_id: itemId, cues });
    },
    // o apito (microfonia) apareceu: o motor já cortou o volume da voz; a TV avisa por alguns segundos
    onFeedback({ hz, mic, mics }: { hz: number | null; mic?: number; mics?: number }) {
      notify(mics && mics > 1 ? t('ctl.feedbackMic', { hz: hz ?? 0, n: (mic ?? 0) + 1 }) : t('ctl.feedback', { hz: hz ?? 0 }), 10000);
    },
    onError(itemId: number, message: string) {
      // não deixa a sala travada numa música que não carrega: avisa, espera um pouco e passa para a próxima
      notify(t('ctl.skipping', { message }), 5000);
      setTimeout(() => {
        if (engine.loadedId !== itemId) return; // a sala já mudou de música
        engine.clear();
        connection.send({ type: 'ended', item_id: itemId });
      }, 2500);
    },
  });

  // --- pontuação ---
  function stopScoring() {
    mic?.stop();
    mic = null;
    micFailed = false;
    scorer = null;
    scorerFor = null;
    shownNotes = '';
    setHud({ visible: false });
  }

  /** Prepara (ou mantém) a pontuação da música atual. */
  async function prepareScoring(state: RoomState, current: QueueItem | null) {
    if (!state.scoring) return stopScoring();
    setHud({ visible: Boolean(current) });
    if (!current) return;
    const melodyUrl = current.song.media?.melody;
    if (!melodyUrl) {
      shownNotes = '';
      scorer = null;
      scorerFor = null;
      return setHud({ notice: t('ctl.noMelody') });
    }
    if (scorerFor === current.id) {
      scorer?.setTranspose(current.pitch);
      return;
    }
    scorerFor = current.id;
    scorer = null;
    shownNotes = '';
    setHud({ score: 0, notice: '' });
    try {
      const res = await fetch(melodyUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const melody = await res.json();
      if (scorerFor !== current.id) return; // a sala já mudou de música
      scorer = createScorer(melody, {
        transpose: current.pitch,
        // depuração: descomente para um log por bloco de 2 s (trecho, nota original, nota cantada e o resultado da comparação)
        // onBlock: (b) => console.log(
        //   `[pontuação] ${b.trecho} | original ${b.original} (principais ${b.principais || '—'}) | cantada ${b.cantada} | `
        //   + `distância ${b.distancia ?? '—'} → acerto ${b.acerto} | leituras ${b.leituras} (participação ${b.participacao})`,
        // ),
      });
    } catch {
      shownNotes = '';
      return setHud({ notice: t('ctl.melodyFail') });
    }
    if (!mic && !micFailed) {
      try {
        mic = await openMic(micsChosen[0]?.id);
      } catch {
        micFailed = true;
      }
    }
    shownNotes = '';
    setHud({ notice: micFailed ? t('ctl.micFail') : '' });
  }

  // ~10 leituras por segundo: compara o tom cantado com a melodia no instante atual da música
  const scoreTimer = setInterval(() => {
    if (!scorer || !mic || !engine.playing || engine.loadedId !== scorerFor) return;
    const { midi } = mic.read();
    const live = scorer.tick(sungPosition(engine.currentTime, latency), midi);
    const original = noteName(scorer.reference);
    const sung = noteName(scorer.sung);
    const key = `${original}|${sung}`;
    if (key !== shownNotes) {
      shownNotes = key;
      setHud({ notice: '', original, sung });
    }
    setHud({ score: live ?? 0 });
  }, 100);

  /** Fim natural da música: manda a nota ao servidor (placar) e mostra o resultado. */
  function reportScore(itemId: number) {
    if (!scorer || scorerFor !== itemId || scorer.evaluated < MIN_SCORED_FRAMES) return;
    const score = scorer.score() as number;
    const singer = latest?.queue.find((item) => item.id === itemId)?.singers ?? '';
    // depuração: descomente para ver a nota final e a tabela com todos os blocos
    // console.log(`[pontuação] fim da música: ${score} pontos`);
    // console.table(scorer.report());
    connection.send({ type: 'score', item_id: itemId, score });
    ui.setFinal({ score, singer, message: finalMessage(score) });
    clearTimeout(finalTimer);
    finalTimer = setTimeout(() => ui.setFinal(null), FINAL_SECONDS * 1000);
  }

  // --- a voz do microfone da TV nas caixas (o anfitrião liga) ---
  let voiceOn = false;
  let voiceFailed = false;
  let voiceBusy = false;
  let voiceKey = ''; // quais microfones estão abertos na saída

  /** Mantém a voz de acordo com a sala: liga/desliga o microfone e põe o volume (mudo enquanto nada toca). */
  async function syncVoice() {
    const state = latest;
    if (!state?.voice) {
      if (voiceOn || voiceFailed) {
        engine.detachVoice();
        voiceOn = false;
        voiceFailed = false;
      }
      return;
    }
    if (voiceOn && voiceKey !== micsKey(micsChosen)) {
      // a escolha de microfones mudou: solta os atuais e abre os novos
      engine.detachVoice();
      voiceOn = false;
      voiceFailed = false;
    }
    if (!voiceOn && !voiceFailed && !voiceBusy) {
      voiceBusy = true;
      try {
        const ids = micsChosen.length ? micsChosen.map((mic) => mic.id) : ['']; // sem escolha: o microfone padrão, como sempre
        const streams: MediaStream[] = [];
        for (const id of ids) {
          try {
            streams.push(await openVoice(id));
          } catch {
            // este microfone não abriu (desconectado, sem permissão): os outros seguem
          }
        }
        if (!streams.length) throw new Error('no microphone');
        await engine.attachVoice(streams);
        voiceKey = micsKey(micsChosen);
        voiceOn = true;
        if (streams.length < ids.length) notify(t('ctl.someMicsFail', { open: streams.length, total: ids.length }), 8000);
      } catch {
        voiceFailed = true;
        notify(t('ctl.voiceMicFail'), 8000);
      } finally {
        voiceBusy = false;
      }
    }
    if (voiceOn) engine.setVoiceGain(voiceGain(state.voice_volume, { playing: engine.playing }));
  }
  const voiceTimer = setInterval(() => void syncVoice(), 400);

  // --- sala ---
  const connection: Connection = connectRoom(code, 'tv', {
    onMessage(message: ServerMessage) {
      if (message.type === 'seek') {
        if (message.item_id !== engine.loadedId) return;
        // sem a duração ainda (o áudio acabou de começar a carregar), não há limite para o salto para a frente
        const limit = engine.duration ? engine.duration - 0.5 : Infinity;
        const target = message.to ?? engine.currentTime + (message.seconds ?? 0); // ponto de destino ou salto relativo
        engine.seek(Math.min(Math.max(target, 0), limit));
        connection.send({ type: 'position', item_id: engine.loadedId, ms: Math.round(engine.heardTime * 1000) });
        return;
      }
      if (message.type !== 'state') return;
      latest = message.state;
      ui.setRoom(latest);
      void syncVoice();
      void apply();
    },
    onStatus(status: string) {
      notify(status === 'reconnecting' ? t('ctl.reconnecting') : '');
    },
    onGone() {
      notify(t('ctl.gone'));
    },
  });

  async function startPlayback() {
    try {
      await engine.play();
      ui.setUnlock(false);
    } catch {
      ui.setUnlock(true); // o navegador exige um clique antes de tocar áudio
    }
  }

  async function syncPlayback(playback: string) {
    if (playback === 'playing') {
      if (!engine.playing) await startPlayback();
    } else if (playback === 'paused') {
      engine.pause();
    }
  }

  /** Aplica o estado mais recente da sala; se chegar outro enquanto carrega, repete até alcançá-lo. */
  async function apply() {
    if (applying) return;
    applying = true;
    try {
      let state: RoomState | null;
      do {
        state = latest;
        if (!state) break;
        const { current }: { current: QueueItem | null } = splitQueue(state);
        void prepareScoring(state, current);
        if (!current) {
          engine.clear();
          endedFor = null;
        } else {
          if (engine.loadedId !== current.id) {
            endedFor = null;
            await engine.load(current);
            // TV recarregada no meio da música: retoma de onde o servidor sabe que estava (a posição é reportada a cada 2 s)
            if (!resumed && state.position_ms > 2000) engine.seek(state.position_ms / 1000);
            resumed = true;
          } else {
            engine.setPitch(current.pitch);
            engine.setBacking(current.backing);
            engine.setOffset(current.lyric_offset);
            engine.setDuet(current.guest?.status === 'accepted');
          }
          await syncPlayback(state.playback);
          if (engine.playing && current.pitch !== 0 && !engine.pitchAvailable) {
            notify(t('ctl.pitchFail'));
          }
        }
      } while (state !== latest);
    } finally {
      applying = false;
    }
  }

  // barra de progresso da música
  const progressTimer = setInterval(() => {
    const duration = engine.duration;
    ui.setProgress(engine.loadedId !== null && duration ? Math.min(100, (engine.currentTime / duration) * 100) : 0);
  }, 250);

  // posição da música para os celulares (barra de progresso e a letra do palco, que anda sozinha entre uma mensagem e outra)
  const positionTimer = setInterval(() => {
    if (engine.playing && engine.loadedId !== null) {
      connection.send({ type: 'position', item_id: engine.loadedId, ms: Math.round(engine.heardTime * 1000) });
    }
  }, 1000);

  engine.setOutputLatency(latency.output);

  return {
    engine,
    get mics() {
      return micsChosen;
    },
    /** Escolhe os microfones da saída (e da pontuação, o primeiro); a voz reabre sozinha com a nova escolha. */
    setMics(next: { id: string; label: string }[]) {
      micsChosen = saveMics(next);
      stopScoring(); // a pontuação reabre o microfone com o primeiro da lista
      void apply();
      void syncVoice();
      return micsChosen;
    },
    get latency() {
      return latency;
    },
    /** Guarda e aplica o atraso da saída (letra) e da entrada (pontuação), em ms. */
    setLatency(next: { output: number; input: number }) {
      latency = saveLatency({ output: clampLatency(next.output), input: clampLatency(next.input) });
      engine.setOutputLatency(latency.output);
      return latency;
    },
    get state() {
      return latest;
    },
    /** Clique em "ativar o som": o navegador só libera o áudio depois de um gesto. */
    async unlock() {
      await engine.unlock();
      await startPlayback();
    },
    stop() {
      clearInterval(scoreTimer);
      clearInterval(progressTimer);
      clearInterval(positionTimer);
      clearInterval(voiceTimer);
      engine.detachVoice();
      clearTimeout(noticeTimer);
      clearTimeout(finalTimer);
      stopScoring();
      engine.clear();
      connection.close();
    },
  };
}

export type TvController = ReturnType<typeof createTvController>;
