// TV: toca o que a sala manda (fila no servidor), mostra a letra e avisa quando a música termina.
import { createEngine } from './engine.js';
import { api, connectRoom, parseRoomCode } from './identity.js';
import { songChip, splitQueue } from './queue-view.js';
import qrcode from './vendor/qrcode/qrcode.mjs';

const $ = (id) => document.getElementById(id);
const els = {
  stage: $('stage'),
  roomCode: $('room-code'),
  nowLabel: $('now-label'),
  upNext: $('up-next'),
  notice: $('notice'),
  idle: $('idle'),
  idleCode: $('idle-code'),
  idleMsg: $('idle-msg'),
  qr: $('qr'),
  joinUrl: $('join-url'),
  unlock: $('unlock'),
  fullscreen: $('fullscreen'),
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

const connection = connectRoom(code, 'tv', {
  onMessage(message) {
    if (message.type !== 'state') return;
    latest = message.state;
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

function renderChrome(state) {
  const { current, waiting } = splitQueue(state);
  els.nowLabel.textContent = current ? `${current.added_by} · ${current.title ?? current.video_id}` : '';
  els.upNext.textContent = waiting.length
    ? `A seguir: ${waiting.slice(0, 3).map((i) => `${i.added_by} — ${i.title ?? i.video_id}${i.song.ready ? '' : ` (${songChip(i.song).label.toLowerCase()})`}`).join('  •  ')}`
    : '';
  els.idle.hidden = Boolean(current);
  if (!current) {
    els.idleMsg.textContent = waiting.length
      ? `Preparando a próxima música: ${waiting[0].title ?? waiting[0].video_id}…`
      : 'Adicione músicas pelo celular para começar.';
  }
}

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
