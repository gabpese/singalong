// TV: toca o que a sala manda (fila no servidor), mostra a letra e avisa quando a música termina.
import { createEngine } from './engine.js';
import { icon } from './icons.js';
import { api, connectRoom, parseRoomCode } from './identity.js';
import { keySummary } from './music.js';
import { nextUp, playOrder, songChip, splitQueue } from './queue-view.js';
import { createScorer, noteName, openMic } from './scoring.js';
import { finalMessage, MIN_SCORED_FRAMES } from './score-view.js';
import qrcode from './vendor/qrcode/qrcode.mjs';

const $ = (id) => document.getElementById(id);
const els = {
  stage: $('stage'),
  roomCode: $('room-code'),
  singerNow: $('singer-now'),
  whoNow: $('who-now'),
  whatNow: $('what-now'),
  keyNow: $('key-now'),
  singerNext: $('singer-next'),
  whoNext: $('who-next'),
  whatNext: $('what-next'),
  bar: $('tv-bar'),
  queueBox: $('tv-queue-box'),
  queueList: $('tv-queue'),
  notice: $('notice'),
  idle: $('idle'),
  idleCode: $('idle-code'),
  idleMsg: $('idle-msg'),
  qr: $('qr'),
  joinUrl: $('join-url'),
  unlock: $('unlock'),
  fullscreen: $('fullscreen'),
  hud: $('score-hud'),
  scoreNow: $('score-now'),
  scoreHint: $('score-hint'),
  final: $('score-final'),
  finalScore: $('final-score'),
  finalWho: $('final-who'),
  finalMsg: $('final-msg'),
  finalBoard: $('final-board'),
};

const code = parseRoomCode(location.search);
if (!code) {
  els.notice.textContent = 'Abra a TV a partir de uma sala (link com ?room=CÓDIGO).';
  throw new Error('sala não informada');
}
els.roomCode.textContent = code;
els.idleCode.textContent = code;
document.title = `Singalong — TV ${code}`;

let latest = null; // último estado da sala
let applying = false;
let endedFor = null; // evita avisar duas vezes que a mesma música terminou
let resumed = false; // só a primeira música carregada depois de abrir a página retoma de uma posição anterior
let noticeTimer = null;

function notify(text, ms = 0) {
  clearTimeout(noticeTimer);
  els.notice.textContent = text;
  if (ms) noticeTimer = setTimeout(() => { els.notice.textContent = ''; }, ms);
}

const engine = createEngine({
  lyricsEls: { prev: $('l-prev'), current: $('l-current'), next: $('l-next'), next2: $('l-next2') },
  onEnded(itemId) {
    if (endedFor === itemId) return;
    endedFor = itemId;
    reportScore(itemId);
    connection.send({ type: 'ended', item_id: itemId });
  },
  onError(itemId, message) {
    // não deixa a sala travada numa música que não carrega: avisa, espera um pouco e passa para a próxima
    notify(`${message} Pulando…`, 5000);
    setTimeout(() => {
      if (engine.loadedId !== itemId) return; // a sala já mudou de música
      engine.clear();
      connection.send({ type: 'ended', item_id: itemId });
    }, 2500);
  },
});

// --- pontuação pelo microfone (só quando o anfitrião liga e a música tem a melodia de referência) ---
let mic = null;
let micFailed = false;
let scorer = null;
let scorerFor = null; // item que o `scorer` acompanha
let finalTimer = null;

function stopScoring() {
  mic?.stop();
  mic = null;
  micFailed = false;
  scorer = null;
  scorerFor = null;
  els.hud.hidden = true;
}

/** Prepara (ou mantém) a pontuação da música atual. */
async function prepareScoring(state, current) {
  const melodyUrl = current?.song.media?.melody;
  if (!state.scoring) return stopScoring();
  els.hud.hidden = !current;
  if (!current) return;
  shownNotes = '';
  els.scoreHint.textContent = melodyUrl ? '' : 'sem melodia de referência para esta música';
  if (!melodyUrl) {
    scorer = null;
    scorerFor = null;
    return;
  }
  if (scorerFor === current.id) {
    scorer?.setTranspose(current.pitch);
    return;
  }
  scorerFor = current.id;
  scorer = null;
  els.scoreNow.textContent = '0';
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
    els.scoreHint.textContent = 'não consegui carregar a melodia';
    return;
  }
  if (!mic && !micFailed) {
    try {
      mic = await openMic();
    } catch {
      micFailed = true;
    }
  }
  shownNotes = '';
  els.scoreHint.textContent = micFailed ? 'microfone indisponível (permita o acesso e abra a TV por http://localhost:3000)' : '';
}

let shownNotes = '';

/** "Original: <b>F#3</b> / Você: <b>F#4</b>" (só mexe no DOM quando uma das notas muda). */
function showNotes(original, sung) {
  const key = `${original}|${sung}`;
  if (key === shownNotes) return;
  shownNotes = key;
  const bold = (text) => Object.assign(document.createElement('b'), { textContent: text });
  els.scoreHint.replaceChildren('Original: ', bold(original), document.createElement('br'), 'Você: ', bold(sung));
}

// ~10 leituras por segundo: compara o tom cantado com a melodia no instante atual da música
setInterval(() => {
  if (!scorer || !mic || !engine.playing || engine.loadedId !== scorerFor) return;
  const { midi } = mic.read();
  const live = scorer.tick(engine.currentTime, midi);
  els.scoreNow.textContent = live ?? 0;
  showNotes(noteName(scorer.reference), noteName(scorer.sung));
}, 100);

/** Fim natural da música: manda a nota ao servidor (placar) e mostra o resultado. */
function reportScore(itemId) {
  if (!scorer || scorerFor !== itemId || scorer.evaluated < MIN_SCORED_FRAMES) return;
  const score = scorer.score();
  // depuração: descomente para ver a nota final e a tabela com todos os blocos
  // console.log(`[pontuação] fim da música: ${score} pontos`);
  // console.table(scorer.report());
  const singer = latest?.queue.find((item) => item.id === itemId)?.added_by ?? '';
  connection.send({ type: 'score', item_id: itemId, score });
  showFinal(score, singer);
}

function renderFinalBoard() {
  els.finalBoard.textContent = '';
  for (const row of (latest?.scoreboard ?? []).slice(0, 3)) {
    const li = document.createElement('li');
    li.textContent = `${row.name} — ${row.score}`; // textContent: nomes vêm de terceiros
    els.finalBoard.append(li);
  }
}

function showFinal(score, singer) {
  els.finalScore.textContent = String(score);
  els.finalWho.textContent = singer;
  els.finalMsg.textContent = finalMessage(score);
  renderFinalBoard();
  els.final.hidden = false;
  clearTimeout(finalTimer);
  finalTimer = setTimeout(() => { els.final.hidden = true; }, 9000);
}

const connection = connectRoom(code, 'tv', {
  onMessage(message) {
    if (message.type === 'seek') {
      if (message.item_id !== engine.loadedId || !engine.duration) return;
      engine.seek(Math.min(Math.max(engine.currentTime + message.seconds, 0), engine.duration - 0.5));
      connection.send({ type: 'position', item_id: engine.loadedId, ms: Math.round(engine.currentTime * 1000) });
      return;
    }
    if (message.type !== 'state') return;
    latest = message.state;
    if (!els.final.hidden) renderFinalBoard();
    apply();
  },
  onStatus(status) {
    notify(status === 'reconnecting' ? 'Reconectando à sala…' : '');
  },
  onGone() {
    notify('Sala não encontrada. Crie uma nova sala.');
  },
});

function showUnlock(show) {
  els.unlock.hidden = !show;
}

async function startPlayback() {
  try {
    await engine.play();
    showUnlock(false);
  } catch {
    showUnlock(true); // o navegador exige um clique antes de tocar áudio
  }
}

async function syncPlayback(playback) {
  if (playback === 'playing') {
    if (!engine.playing) await startPlayback();
  } else if (playback === 'paused') {
    engine.pause();
  }
}

const trackName = (item) => [item.title ?? item.video_id, item.artist].filter(Boolean).join(' — ');
const UPCOMING_SHOWN = 5;

function queueRow(item, badge, isCurrent = false) {
  const row = document.createElement('li');
  row.className = isCurrent ? 'is-current' : '';
  const mark = document.createElement('span');
  mark.className = 'mark';
  mark.textContent = badge;
  const text = document.createElement('span');
  text.className = 'text';
  const who = document.createElement('strong');
  who.textContent = item.added_by; // textContent: nomes e títulos vêm de terceiros
  const what = document.createElement('small');
  what.textContent = `${item.title ?? item.video_id}${item.song.ready ? '' : ` · ${songChip(item.song).label.toLowerCase()}`}`;
  text.append(who, what);
  row.append(mark, text);
  return row;
}

/** Lista lateral: a música atual e as próximas 5, na ordem em que vão tocar (para ceder a vez com conhecimento de causa). */
function renderQueue(state) {
  const { current, upcoming } = playOrder(state);
  els.queueList.textContent = '';
  if (current) els.queueList.append(queueRow(current, '▶', true));
  upcoming.slice(0, UPCOMING_SHOWN).forEach((item, i) => els.queueList.append(queueRow(item, String(i + 1))));
  if (upcoming.length > UPCOMING_SHOWN) {
    const more = document.createElement('li');
    more.className = 'more';
    more.textContent = `+ ${upcoming.length - UPCOMING_SHOWN} na fila`;
    els.queueList.append(more);
  }
  const visible = Boolean(current) || upcoming.length > 0;
  els.queueBox.hidden = !visible;
  els.stage.classList.toggle('has-queue', visible);
}

/** Cabeçalho: quem canta agora → próximo cantor; o tom; a fila que vem depois. */
function renderChrome(state) {
  const { current } = splitQueue(state);
  const next = nextUp(state);

  els.singerNow.hidden = !current;
  if (current) {
    els.whoNow.replaceChildren(icon('singing'), ` ${current.added_by}`);
    els.whatNow.textContent = trackName(current);
    els.keyNow.textContent = keySummary(current.song.key, current.pitch);
  }

  els.singerNext.hidden = !next;
  if (next) {
    els.whoNext.replaceChildren(icon('singing'), ` ${next.item.added_by}`);
    els.whatNext.textContent = `${next.item.title ?? next.item.video_id}${next.preparing ? ' (preparando…)' : ''}`;
  }

  renderQueue(state);

  els.idle.hidden = Boolean(current);
  if (!current) {
    els.idleMsg.textContent = next
      ? `Próximo: ${next.item.added_by} — ${next.item.title ?? next.item.video_id}${next.preparing ? ' (preparando…)' : ''}`
      : 'Adicione músicas pelo celular para começar.';
  }
}

// barra de progresso da música
setInterval(() => {
  const duration = engine.duration;
  els.bar.style.width = engine.loadedId !== null && duration ? `${Math.min(100, (engine.currentTime / duration) * 100)}%` : '0%';
}, 250);

/** Aplica o estado mais recente da sala; se chegar outro enquanto carrega, repete até alcançá-lo. */
async function apply() {
  if (applying) return;
  applying = true;
  try {
    let state;
    do {
      state = latest;
      renderChrome(state);
      const { current } = splitQueue(state);
      prepareScoring(state, current);
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
          engine.setOffset(current.lyric_offset);
        }
        await syncPlayback(state.playback);
        if (engine.playing && current.pitch !== 0 && !engine.pitchAvailable) {
          notify('Troca de tom indisponível aqui: abra a TV por http://localhost:3000 (ou use https).');
        }
      }
    } while (state !== latest);
  } finally {
    applying = false;
  }
}

// posição da música para os celulares (barra de progresso)
setInterval(() => {
  if (engine.playing && engine.loadedId !== null) {
    connection.send({ type: 'position', item_id: engine.loadedId, ms: Math.round(engine.currentTime * 1000) });
  }
}, 2000);

els.unlock.addEventListener('click', async () => {
  await engine.unlock();
  await startPlayback();
});

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else els.stage.requestFullscreen?.();
}
els.fullscreen.addEventListener('click', toggleFullscreen);
document.addEventListener('keydown', (e) => {
  if ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey) toggleFullscreen();
});

// QR code para entrar na sala: usa PUBLIC_URL (o endereço que os celulares alcançam) ou o da própria página
(async () => {
  let base = location.origin;
  let configured = false;
  try {
    const config = await api('GET', '/api/config');
    if (config.public_url) {
      base = config.public_url;
      configured = true;
    }
  } catch {
    // sem config: usa a origem da página
  }
  const url = `${base}/room.html?room=${code}`;
  const qr = qrcode(0, 'M');
  qr.addData(url);
  qr.make();
  els.qr.innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  els.joinUrl.textContent = url;
  if (!configured && ['localhost', '127.0.0.1'].includes(location.hostname)) {
    els.joinUrl.textContent += '  —  para o QR funcionar nos celulares, defina PUBLIC_URL (ex.: http://192.168.0.10:3000)';
  }
})();

// gancho de diagnóstico (testes no navegador)
window.tv = {
  engine,
  get state() { return latest; },
};
