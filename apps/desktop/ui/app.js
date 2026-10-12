// A janela do app: só mostra o estado que vem do processo principal e chama as ações. Nenhum texto de fora entra como HTML.
const $ = (id) => document.getElementById(id);
const api = window.karaoke;

let state = null;
let importFile = null;
let autoStarted = false;

const AGENT_TEXT = {
  stopped: ['Parada', ''],
  starting: ['Conectando…', 'warn'],
  online: ['Online', 'ok'],
  offline: ['Sem conexão', 'bad'],
  auth_error: ['Acesso recusado', 'bad'],
};
const YT_TEXT = { unknown: ['Não conferido', ''], connected: ['Conectado', 'ok'], 'not-logged': ['Sem login', 'warn'] };

function showError(message) {
  const box = $('error');
  box.textContent = message || '';
  box.hidden = !message;
}

/** Chama uma ação do processo principal; mostra o erro (se houver) e devolve os dados ou null. */
async function act(name, arg, button) {
  if (button) button.disabled = true;
  showError('');
  try {
    const result = await api[name](arg);
    if (!result.ok) {
      showError(result.error.message);
      return null;
    }
    return result.data;
  } finally {
    if (button) button.disabled = false;
  }
}

function setPill(el, [text, kind]) {
  el.textContent = text;
  el.className = `pill ${kind}`.trim();
}

function render(s) {
  state = s;
  $('version').textContent = `v${s.version}`;
  const running = s.agent.status !== 'stopped' && s.agent.status !== 'auth_error';
  $('screen-engine').hidden = s.phase !== 'engine';
  $('screen-pair').hidden = s.phase !== 'pair';
  $('screen-welcome').hidden = !(s.phase === 'home' && !running);
  $('screen-home').hidden = !(s.phase === 'home' && running);
  if (s.phase === 'engine' && s.engine.status === 'missing' && !autoStarted) { // primeira abertura: começa sozinho, sem perguntar
    autoStarted = true;
    act('buildEngine', { engine: 'auto' });
  }

  // atualização
  const u = s.update;
  $('update').hidden = !(u && (u.status === 'update_available' || u.status === 'update_required'));
  if (!$('update').hidden) {
    $('update-title').textContent = u.status === 'update_required' ? `Atualização necessária (versão ${u.minimum ?? u.latest} ou mais nova)` : `Há uma versão nova: ${u.latest}`;
    $('update-notes').textContent = u.notes ?? '';
    $('update-open').hidden = !u.url;
    const progress = s.updateProgress;
    $('update-open').disabled = Boolean(progress);
    $('update-open').textContent = progress ? `Baixando… ${progress.percent}%` : 'Atualizar agora';
  }

  // motor
  const building = s.engine.status !== 'error';
  $('engine-build').hidden = building;
  $('engine-progress').hidden = !building;
  if (s.engine.progress) {
    const p = s.engine.progress;
    $('engine-label').textContent = p.label;
    if (p.total) $('engine-bar').value = Math.round((p.done / p.total) * 100);
    else $('engine-bar').removeAttribute('value');
  }
  $('engine-error').hidden = !s.engine.error;
  $('engine-error').textContent = s.engine.error ?? '';

  // início
  const online = s.agent.status === 'online';
  setPill($('agent-pill'), AGENT_TEXT[s.agent.status] ?? ['?', '']);
  $('session-nick').textContent = s.nickname ?? '';
  if (document.activeElement !== $('welcome-nickname') && !$('welcome-nickname').value) $('welcome-nickname').value = s.nickname ?? '';
  $('welcome-server').textContent = s.server ? s.server.replace(/^https?:\/\//, '') : '';
  $('welcome-error').hidden = s.agent.status !== 'auth_error';
  $('welcome-error').textContent = s.agent.status === 'auth_error' ? s.agent.error ?? '' : '';
  $('agent-error').hidden = !s.agent.error;
  $('agent-error').textContent = s.agent.error ?? '';
  $('room-create').disabled = !online || Boolean(s.busy);
  $('import-pick').disabled = Boolean(s.busy);
  $('import-go').disabled = Boolean(s.busy);
  $('yt-login').disabled = Boolean(s.busy);
  setPill($('yt-pill'), YT_TEXT[s.youtube.status] ?? ['?', '']);
  if (document.activeElement !== $('browser')) $('browser').value = s.browser ?? 'auto';
  renderRooms(s.rooms);
  renderLogs(s.logs);
  if (s.busy) $('import-result').textContent = `${s.busy}…`;
}

function renderRooms(rooms) {
  const list = $('rooms');
  list.replaceChildren();
  for (const room of rooms) {
    const item = document.createElement('li');
    item.dataset.testid = `room-${room.code}`;
    const code = document.createElement('span');
    code.className = 'code';
    code.textContent = room.code;
    const tv = document.createElement('button');
    tv.type = 'button';
    tv.textContent = 'Abrir a TV';
    tv.addEventListener('click', () => act('open', room.tv));
    const host = document.createElement('button');
    host.type = 'button';
    host.textContent = 'Abrir como anfitrião';
    host.addEventListener('click', () => act('open', room.host));
    item.append(code, tv, host);
    list.append(item);
  }
}

function renderLogs(logs) {
  const box = $('logs');
  const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 8;
  box.replaceChildren();
  for (const entry of logs) {
    const line = document.createElement('div');
    if (entry.level === 'error') line.className = 'error';
    line.textContent = entry.line;
    box.append(line);
  }
  if (stick) box.scrollTop = box.scrollHeight;
}

// --- ações ---
$('engine-build').addEventListener('click', (e) => act('buildEngine', { engine: 'auto' }, e.currentTarget));

$('pair-go').addEventListener('click', async (e) => {
  const data = await act('pair', { server: $('pair-server').value, code: $('pair-code').value, name: $('pair-name').value }, e.currentTarget);
  if (data) $('pair-code').value = '';
});

$('welcome-start').addEventListener('click', (e) => act('startAgent', { nickname: $('welcome-nickname').value }, e.currentTarget));
$('welcome-nickname').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('welcome-start').click(); });
$('session-toggle').addEventListener('click', (e) => act('stopAgent', undefined, e.currentTarget));

$('room-create').addEventListener('click', (e) => act('createRoom', undefined, e.currentTarget));

$('import-pick').addEventListener('click', async () => {
  const file = await act('pickAudio');
  if (!file) return;
  importFile = file;
  $('import-file').textContent = file;
  $('import-form').hidden = false;
  $('import-result').hidden = true;
});

$('import-go').addEventListener('click', async (e) => {
  $('import-result').hidden = false;
  $('import-result').textContent = 'Importando… (a primeira vez demora mais)';
  const data = await act('importFile', { file: importFile, artist: $('import-artist').value.trim(), title: $('import-title').value.trim() }, e.currentTarget);
  $('import-result').textContent = data ? data.message : '';
  if (data) {
    $('import-form').hidden = true;
    $('import-artist').value = '';
    $('import-title').value = '';
    importFile = null;
  }
});

$('yt-login').addEventListener('click', (e) => act('youtubeLogin', undefined, e.currentTarget));
$('yt-check').addEventListener('click', (e) => act('youtubeStatus', undefined, e.currentTarget));
$('browser').addEventListener('change', () => act('settings', { browser: $('browser').value }));
$('login-item').addEventListener('change', (e) => act('loginItem', e.currentTarget.checked));
$('update-open').addEventListener('click', () => state.update?.url && act('applyUpdate', undefined, $('update-open')));

$('hardware').addEventListener('click', async (e) => {
  const data = await act('hardware', undefined, e.currentTarget);
  if (!data) return;
  const gpu = data.gpus?.[0];
  $('hardware-out').hidden = false;
  $('hardware-out').textContent = [
    `Processador: ${data.cpu_cores} núcleos · Memória: ${data.ram_mb ? Math.round(data.ram_mb / 1024) : '?'} GB`,
    `Placa de vídeo: ${gpu ? `${gpu.name} (driver ${gpu.driver})` : 'nenhuma NVIDIA encontrada'}`,
    `Motor recomendado: ${data.engine === 'cu121' ? 'placa de vídeo' : 'processador'} — ${data.reason}`,
    `Motor instalado: ${state.engine.kind === 'cu121' ? 'placa de vídeo' : 'processador'}${state.engine.reason ? ` — ${state.engine.reason}` : ''}`,
  ].join('\n');
});

async function unpair(button) {
  if (!confirm('Desparear este computador? Você vai precisar de um código novo para conectar de novo.')) return;
  await act('unpair', undefined, button);
}
$('unpair').addEventListener('click', (e) => unpair(e.currentTarget));
$('welcome-unpair').addEventListener('click', (e) => unpair(e.currentTarget));

api.onState(render);
const first = await act('snapshot');
if (first) render(first);
api.loginItem().then((r) => { if (r.ok) $('login-item').checked = r.data; });
