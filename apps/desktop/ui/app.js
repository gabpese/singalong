// A janela do app: só mostra o estado que vem do processo principal e chama as ações. Nenhum texto de fora entra como HTML.
const $ = (id) => document.getElementById(id);
const api = window.karaoke;

let state = null;
let importFile = null;

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
  $('screen-engine').hidden = s.phase !== 'engine';
  $('screen-pair').hidden = s.phase !== 'pair';
  $('screen-home').hidden = s.phase !== 'home';

  // atualização
  const u = s.update;
  $('update').hidden = !(u && (u.status === 'update_available' || u.status === 'update_required'));
  if (!$('update').hidden) {
    $('update-title').textContent = u.status === 'update_required' ? `Atualização necessária (versão ${u.minimum ?? u.latest} ou mais nova)` : `Há uma versão nova: ${u.latest}`;
    $('update-notes').textContent = u.notes ?? '';
    $('update-open').hidden = !u.url;
  }

  // motor
  const building = s.engine.status === 'building';
  $('engine-build').disabled = building;
  $('engine-build').textContent = s.engine.status === 'error' ? 'Tentar de novo' : 'Preparar';
  $('engine-kind').disabled = building;
  $('engine-progress').hidden = !building;
  if (building && s.engine.progress) {
    const p = s.engine.progress;
    $('engine-label').textContent = p.total ? `${p.label} (${Math.round((p.done / p.total) * 100)}%)` : p.label;
    if (p.total) $('engine-bar').value = Math.round((p.done / p.total) * 100);
    else $('engine-bar').removeAttribute('value');
  }
  $('engine-error').hidden = !s.engine.error;
  $('engine-error').textContent = s.engine.error ?? '';

  // início
  const online = s.agent.status === 'online';
  const running = s.agent.status !== 'stopped' && s.agent.status !== 'auth_error';
  setPill($('agent-pill'), AGENT_TEXT[s.agent.status] ?? ['?', '']);
  $('session-toggle').textContent = running ? 'Encerrar sessão' : 'Iniciar sessão';
  $('session-toggle').classList.toggle('primary', !running);
  $('nickname').disabled = running;
  if (document.activeElement !== $('nickname') && !$('nickname').value) $('nickname').value = s.nickname ?? '';
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
$('engine-build').addEventListener('click', (e) => act('buildEngine', { engine: $('engine-kind').value }, e.currentTarget));

$('pair-go').addEventListener('click', async (e) => {
  const data = await act('pair', { server: $('pair-server').value, code: $('pair-code').value, name: $('pair-name').value }, e.currentTarget);
  if (data) $('pair-code').value = '';
});

$('session-toggle').addEventListener('click', async (e) => {
  const running = state.agent.status !== 'stopped' && state.agent.status !== 'auth_error';
  if (running) await act('stopAgent', undefined, e.currentTarget);
  else await act('startAgent', { nickname: $('nickname').value }, e.currentTarget);
});

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
$('update-open').addEventListener('click', () => state.update?.url && act('open', state.update.url));

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

$('unpair').addEventListener('click', async (e) => {
  if (!confirm('Desparear este computador? Você vai precisar de um código novo para conectar de novo.')) return;
  await act('unpair', undefined, e.currentTarget);
});

api.onState(render);
const first = await act('snapshot');
if (first) render(first);
api.loginItem().then((r) => { if (r.ok) $('login-item').checked = r.data; });
