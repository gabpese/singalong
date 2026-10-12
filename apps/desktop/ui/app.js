// A janela do app: só mostra o estado que vem do processo principal e chama as ações. Nenhum texto de fora entra como HTML.
const $ = (id) => document.getElementById(id);
const api = window.karaoke;

let state = null;
let importFile = null;
let autoStarted = false;
let checkedYoutube = false;
let tabs = { active: 'session', room: null };

const AGENT_TEXT = {
  stopped: ['Parada', ''],
  starting: ['Conectando…', 'warn'],
  online: ['Online', 'ok'],
  offline: ['Sem conexão', 'bad'],
  auth_error: ['Acesso recusado', 'bad'],
};
const YT_TEXT = { unknown: ['Não conectado', ''], connected: ['Conectado', 'ok'], 'not-logged': ['Não conectado', 'warn'] };

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
      if (result.error.code !== 'cancelled') showError(result.error.message);
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
  const paired = s.phase === 'home';
  $('screen-engine').hidden = s.phase !== 'engine';
  $('screen-pair').hidden = s.phase !== 'pair';
  $('screen-welcome').hidden = !(paired && !running);
  $('screen-home').hidden = !(paired && running);
  $('tabs').hidden = !(paired && running);
  $('main').classList.toggle('full', paired && !running); // a tela de início usa a janela inteira
  if (s.phase === 'engine' && s.engine.status === 'missing' && !autoStarted) { // primeira abertura: começa sozinho, sem perguntar
    autoStarted = true;
    act('buildEngine', { engine: 'auto' });
  }
  if (paired && !running && s.youtube.status === 'unknown' && !checkedYoutube) { // já tinha entrado antes? confere em silêncio
    checkedYoutube = true;
    api.youtubeStatus();
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

  // instalando componentes
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

  // início (sem sessão)
  setPill($('yt-pill'), YT_TEXT[s.youtube.status] ?? ['?', '']);
  $('yt-login').textContent = s.youtube.status === 'connected' ? 'Trocar de conta' : 'Entrar no YouTube';
  if (document.activeElement !== $('welcome-nickname') && !$('welcome-nickname').value) $('welcome-nickname').value = s.nickname ?? '';
  $('welcome-server').textContent = s.server ? s.server.replace(/^https?:\/\//, '') : '';
  $('welcome-error').hidden = s.agent.status !== 'auth_error';
  $('welcome-error').textContent = s.agent.status === 'auth_error' ? s.agent.error ?? '' : '';
  $('library-welcome').textContent = s.libraryDir ?? '';

  // sessão em andamento
  const online = s.agent.status === 'online';
  setPill($('agent-pill'), AGENT_TEXT[s.agent.status] ?? ['?', '']);
  setPill($('yt-pill-home'), YT_TEXT[s.youtube.status] ?? ['?', '']);
  $('session-nick').textContent = s.nickname ?? '';
  $('agent-error').hidden = !s.agent.error;
  $('agent-error').textContent = s.agent.error ?? '';
  $('room-create').disabled = !online || Boolean(s.busy);
  $('import-pick').disabled = Boolean(s.busy);
  $('import-go').disabled = Boolean(s.busy);
  $('library-home').textContent = s.libraryDir ?? '';
  $('library-change-home').hidden = true; // a pasta só muda com a sessão parada (tela de início)
  renderRooms(s.rooms);

  // espera: login do YouTube e importação
  const waiting = s.busy === 'login do YouTube';
  $('wait').hidden = !waiting;
  if (waiting) {
    $('wait-title').textContent = 'Aguardando conexão…';
    $('wait-text').textContent = `Entre na sua conta do YouTube na janela do ${s.browserName?.replace(/^o /, '') ?? 'navegador'} que foi aberta. Esta tela fecha sozinha quando a conexão for feita.`;
  }
  if (s.busy === 'importando música') $('import-result').textContent = 'Importando… (a primeira vez demora mais)';
  renderTabs();
}

function renderRooms(rooms) {
  const list = $('rooms');
  list.replaceChildren();
  for (const room of rooms) {
    const item = document.createElement('li');
    item.dataset.testid = `room-${room.code}`;
    item.setAttribute('data-testid', `room-${room.code}`);
    const code = document.createElement('span');
    code.className = 'code';
    code.textContent = room.code;
    const open = document.createElement('button');
    open.type = 'button';
    open.textContent = tabs.room === room.code ? 'Aberta' : 'Abrir';
    open.disabled = tabs.room === room.code;
    open.setAttribute('data-testid', `open-${room.code}`);
    open.addEventListener('click', () => act('openRoom', room.code));
    item.append(code, open);
    list.append(item);
  }
}

/** As abas Anfitrião e TV são páginas do servidor dentro da janela: quando uma delas está ativa, a interface só mostra as abas. */
function renderTabs() {
  const paired = state?.phase === 'home';
  const running = state && state.agent.status !== 'stopped' && state.agent.status !== 'auth_error';
  const web = running && paired && tabs.active !== 'session' && tabs.room;
  for (const button of document.querySelectorAll('.tab[data-tab]')) {
    const name = button.dataset.tab;
    button.classList.toggle('active', tabs.active === name);
    if (name !== 'session') button.disabled = !tabs.room;
  }
  $('tab-room').textContent = tabs.room ? `Sala ${tabs.room}` : '';
  $('tab-back').hidden = !web;
  $('tab-fullscreen').hidden = tabs.active !== 'tv' || !web;
  $('main').hidden = Boolean(web);
  renderRooms(state?.rooms ?? []);
  reportLayout();
}

/** Diz ao processo principal onde a interface termina (as páginas das abas começam logo abaixo). */
let lastTop = 0;
function reportLayout() {
  const top = Math.ceil($('chrome').getBoundingClientRect().bottom);
  if (top !== lastTop) {
    lastTop = top;
    api.layout(top);
  }
}
new ResizeObserver(reportLayout).observe($('chrome'));

// --- ações ---
$('engine-build').addEventListener('click', (e) => act('buildEngine', { engine: 'auto' }, e.currentTarget));

$('pair-go').addEventListener('click', async (e) => {
  const data = await act('pair', { server: $('pair-server').value, code: $('pair-code').value, name: $('pair-name').value }, e.currentTarget);
  if (data) $('pair-code').value = '';
});

$('welcome-start').addEventListener('click', (e) => act('startAgent', { nickname: $('welcome-nickname').value }, e.currentTarget));
$('welcome-nickname').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('welcome-start').click(); });
$('session-toggle').addEventListener('click', (e) => act('stopAgent', undefined, e.currentTarget));
$('room-create').addEventListener('click', async (e) => {
  const room = await act('createRoom', undefined, e.currentTarget);
  if (room) act('openRoom', room.code); // a sala nova já abre na aba do anfitrião
});

for (const button of document.querySelectorAll('.tab[data-tab]')) button.addEventListener('click', () => act('selectTab', button.dataset.tab));
$('tab-back').addEventListener('click', () => act('selectTab', 'session'));
$('tab-fullscreen').addEventListener('click', () => act('fullscreen'));

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

// o login abre o navegador PADRÃO do Windows, depois de pedir licença (o aviso é do processo principal)
$('yt-login').addEventListener('click', (e) => act('youtubeLogin', undefined, e.currentTarget));
$('yt-login-home').addEventListener('click', (e) => act('youtubeLogin', undefined, e.currentTarget));
$('yt-check').addEventListener('click', (e) => act('youtubeStatus', undefined, e.currentTarget));
$('wait-cancel').addEventListener('click', () => act('cancelBusy'));

async function changeLibrary() {
  const dir = await act('pickFolder');
  if (dir) await act('setLibrary', dir);
}
$('library-change-welcome').addEventListener('click', changeLibrary);

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
api.onTabs((value) => {
  tabs = value;
  renderTabs();
});
const first = await act('snapshot');
if (first) render(first);
api.loginItem().then((r) => { if (r.ok) $('login-item').checked = r.data; });
