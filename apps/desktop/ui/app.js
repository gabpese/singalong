// A janela do app: só mostra o estado que vem do processo principal e chama as ações. Nenhum texto de fora entra como HTML.
const $ = (id) => document.getElementById(id);
const api = window.karaoke;

let state = null;
let importFile = null;
let autoStarted = false;
let checkedYoutube = false;
let tabs = { tab: 'session', rooms: [], room: null, sub: 'tv', settings: false };
let hardwareInfo = null;

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

const isRunning = (s) => s.agent.status !== 'stopped' && s.agent.status !== 'auth_error';

function render(s) {
  state = s;
  $('version').textContent = `v${s.version}`;
  const running = isRunning(s);
  const paired = s.phase === 'home';
  const settings = paired && tabs.settings;
  $('gear').hidden = !paired;
  $('screen-engine').hidden = s.phase !== 'engine';
  $('screen-pair').hidden = s.phase !== 'pair';
  $('screen-welcome').hidden = !(paired && !running && !settings);
  $('screen-home').hidden = !(paired && running && !settings);
  $('screen-settings').hidden = !settings;
  $('tabs').hidden = !(paired && running);
  $('main').classList.toggle('full', paired && !running && !settings); // a tela de início usa a janela inteira
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

  // instalando componentes (também aparece ao trocar a placa de vídeo)
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
  if (!$('pair-server').value) $('pair-server').value = s.defaultServer ?? '';
  $('welcome-server').textContent = s.server ? s.server.replace(/^https?:\/\//, '') : '';
  $('welcome-error').hidden = s.agent.status !== 'auth_error';
  $('welcome-error').textContent = s.agent.status === 'auth_error' ? s.agent.error ?? '' : '';

  // sessão em andamento
  const online = s.agent.status === 'online';
  const creating = s.busy === 'criando sala';
  setPill($('agent-pill'), AGENT_TEXT[s.agent.status] ?? ['?', '']);
  $('session-nick').textContent = s.nickname ?? '';
  $('cloud-note').hidden = !s.agent.cloud;
  $('agent-error').hidden = !s.agent.error;
  $('agent-error').textContent = s.agent.error ?? '';
  $('room-create').disabled = !online || Boolean(s.busy);
  $('room-create-spinner').hidden = !creating;
  $('room-create-label').textContent = creating ? 'Criando a sala…' : 'Criar sala';
  $('import-pick').disabled = Boolean(s.busy);
  $('import-go').disabled = Boolean(s.busy);
  renderRooms(s.rooms, creating);

  // configurações
  setPill($('yt-pill-home'), YT_TEXT[s.youtube.status] ?? ['?', '']);
  $('library-home').textContent = s.libraryDir ?? '';
  $('library-change').disabled = running;
  $('library-note').hidden = !running;
  $('gpu-apply').disabled = running;
  $('gpu-note').hidden = !running;
  $('gpu-note').textContent = running ? 'Encerre a sessão para trocar a placa de vídeo.' : '';
  renderGpu();

  // espera: login do YouTube
  const waiting = s.busy === 'login do YouTube';
  $('wait').hidden = !waiting;
  if (waiting) {
    $('wait-title').textContent = 'Aguardando conexão…';
    $('wait-text').textContent = `Entre na sua conta do YouTube na janela do ${s.browserName?.replace(/^o /, '') ?? 'navegador'} que foi aberta. Esta tela fecha sozinha quando a conexão for feita.`;
  }
  if (s.busy === 'importando música') $('import-result').textContent = 'Importando… (a primeira vez demora mais)';
  renderTabs();
}

function renderRooms(rooms, creating = false) {
  const list = $('rooms');
  list.replaceChildren();
  if (creating) {
    const item = document.createElement('li');
    item.setAttribute('data-testid', 'room-creating');
    item.className = 'loading';
    const spinner = document.createElement('span');
    spinner.className = 'spinner small';
    const text = document.createElement('span');
    text.textContent = 'Criando a sala…';
    item.append(spinner, text);
    list.append(item);
  }
  for (const room of rooms) {
    const item = document.createElement('li');
    item.setAttribute('data-testid', `room-${room.code}`);
    const code = document.createElement('span');
    code.className = 'code';
    code.textContent = room.code;
    const enter = document.createElement('button');
    enter.type = 'button';
    enter.textContent = 'Entrar';
    enter.setAttribute('data-testid', `enter-${room.code}`);
    enter.addEventListener('click', () => act('openRoom', room.code));
    item.append(code, enter);
    list.append(item);
  }
}

/** "Salas" tem as salas abertas e, em cada uma, as sub-abas TV e Anfitrião: as páginas do servidor ficam dentro da janela. */
function renderTabs() {
  if (!state) return;
  const running = isRunning(state) && state.phase === 'home';
  const inRooms = running && tabs.tab === 'rooms' && tabs.rooms.length > 0 && !tabs.settings;
  $('tab-session').classList.toggle('active', tabs.tab === 'session' || tabs.settings);
  $('tab-rooms').classList.toggle('active', tabs.tab === 'rooms' && !tabs.settings);
  $('tab-rooms').disabled = tabs.rooms.length === 0;
  $('rooms-count').textContent = tabs.rooms.length ? String(tabs.rooms.length) : '';
  $('subtabs').hidden = !inRooms;
  $('sub-tv').classList.toggle('active', tabs.sub === 'tv');
  $('sub-host').classList.toggle('active', tabs.sub === 'host');
  const chips = $('room-chips');
  chips.replaceChildren();
  for (const code of tabs.rooms) {
    const chip = document.createElement('span');
    chip.className = `chip${code === tabs.room ? ' active' : ''}`;
    const pick = document.createElement('button');
    pick.type = 'button';
    pick.textContent = `Sala ${code}`;
    pick.setAttribute('data-testid', `chip-${code}`);
    pick.addEventListener('click', () => act('selectRoom', code));
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '×';
    close.title = 'Fechar esta sala (ela continua existindo)';
    close.setAttribute('aria-label', `Fechar a sala ${code}`);
    close.setAttribute('data-testid', `close-${code}`);
    close.addEventListener('click', () => act('closeRoom', code));
    chip.append(pick, close);
    chips.append(chip);
  }
  const web = inRooms; // com uma sala aberta, a janela só mostra o cabeçalho e as abas (a página da sala ocupa o resto)
  $('main').hidden = web;
  reportLayout();
}

/** Diz ao processo principal onde a interface termina (as páginas das salas começam logo abaixo). */
let lastTop = 0;
function reportLayout() {
  const top = Math.ceil($('chrome').getBoundingClientRect().bottom);
  if (top !== lastTop) {
    lastTop = top;
    api.layout(top);
  }
}
new ResizeObserver(reportLayout).observe($('chrome'));

// --- configurações ---
function renderGpu() {
  const select = $('gpu-select');
  if (!state || $('screen-settings').hidden) return;
  if (document.activeElement === select) return;
  const gpu = hardwareInfo?.gpus?.[0];
  const options = [['auto', hardwareInfo ? `Automático (recomendado: ${hardwareInfo.engine === 'cu121' ? 'placa de vídeo' : 'processador'})` : 'Automático']];
  if (gpu) options.push(['cu121', `Placa de vídeo: ${gpu.name}`]);
  options.push(['cpu', 'Processador (mais lento)']);
  const current = state.engine.kind;
  const wanted = current === 'cu121' ? 'cu121' : current === 'cpu' ? 'cpu' : 'auto';
  if (select.dataset.signature !== JSON.stringify(options) + wanted) {
    select.replaceChildren(...options.map(([value, label]) => Object.assign(document.createElement('option'), { value, textContent: label })));
    select.value = options.some(([value]) => value === wanted) ? wanted : 'auto';
    select.dataset.signature = JSON.stringify(options) + wanted;
  }
  const machine = hardwareInfo ? `${hardwareInfo.cpu_cores} núcleos · ${hardwareInfo.ram_mb ? Math.round(hardwareInfo.ram_mb / 1024) : '?'} GB de memória · ${gpu ? `${gpu.name} (driver ${gpu.driver})` : 'sem placa NVIDIA'}` : '';
  $('gpu-info').textContent = `Em uso: ${current === 'cu121' ? 'placa de vídeo' : 'processador'}${state.engine.reason ? ` (${state.engine.reason})` : ''}. ${machine}`;
}

async function loadMicrophones() {
  const select = $('mic-select');
  let devices = [];
  try {
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true }); // só para o navegador mostrar os nomes dos microfones
    probe.getTracks().forEach((track) => track.stop());
  } catch {
    /* sem permissão ou sem microfone: a lista pode vir sem nomes */
  }
  try {
    devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
  } catch {
    devices = [];
  }
  const chosen = state?.microphone?.id ?? '';
  const options = [{ value: '', label: 'Padrão do sistema' }, ...devices.map((d, i) => ({ value: d.deviceId, label: d.label || `Microfone ${i + 1}` }))];
  if (chosen && !options.some((o) => o.value === chosen)) options.push({ value: chosen, label: `${state.microphone.label || 'Microfone escolhido'} (desconectado)` });
  select.replaceChildren(...options.map((o) => Object.assign(document.createElement('option'), o.value === chosen ? { value: o.value, textContent: o.label, selected: true } : { value: o.value, textContent: o.label })));
  select.value = chosen;
}

async function openSettings() {
  await act('settingsOpen', true);
  hardwareInfo ??= await act('hardware');
  renderGpu();
  loadMicrophones();
}

// --- ações ---
$('engine-build').addEventListener('click', (e) => act('buildEngine', { engine: 'auto' }, e.currentTarget));

$('pair-send').addEventListener('click', async (e) => {
  $('pair-sent').hidden = true;
  const data = await act('requestCode', { server: $('pair-server').value, email: $('pair-email').value }, e.currentTarget);
  if (data) {
    $('pair-sent').hidden = false;
    $('pair-sent').textContent = data.message;
    $('pair-code').focus();
  }
});
$('pair-email').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('pair-send').click(); });
$('pair-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('pair-go').click(); });

$('pair-go').addEventListener('click', async (e) => {
  const data = await act('pair', { server: $('pair-server').value, code: $('pair-code').value, name: $('pair-name').value }, e.currentTarget);
  if (data) $('pair-code').value = '';
});

$('welcome-start').addEventListener('click', (e) => act('startAgent', { nickname: $('welcome-nickname').value }, e.currentTarget));
$('welcome-nickname').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('welcome-start').click(); });
$('session-toggle').addEventListener('click', (e) => act('stopAgent', undefined, e.currentTarget));
$('room-create').addEventListener('click', async (e) => {
  const room = await act('createRoom', undefined, e.currentTarget);
  if (room) act('openRoom', room.code); // a sala nova já abre, no modo TV
});

for (const button of document.querySelectorAll('.tab[data-tab]')) button.addEventListener('click', () => act('selectTab', button.dataset.tab));
for (const button of document.querySelectorAll('.subtab[data-sub]')) button.addEventListener('click', () => act('selectSub', button.dataset.sub));
$('gear').addEventListener('click', () => (tabs.settings ? act('settingsOpen', false) : openSettings()));
$('settings-back').addEventListener('click', () => act('settingsOpen', false));

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

$('library-change').addEventListener('click', async () => {
  const dir = await act('pickFolder');
  if (dir) await act('setLibrary', dir);
});

$('gpu-apply').addEventListener('click', async (e) => {
  const kind = $('gpu-select').value;
  const current = state.engine.kind === 'cu121' ? 'cu121' : 'cpu';
  if (kind !== 'auto' && kind === current) return;
  if (!confirm('Trocar a placa de vídeo? O aplicativo vai reinstalar parte dos componentes.')) return;
  await act('settingsOpen', false);
  await act('buildEngine', { engine: kind, switchEngine: true }, e.currentTarget);
});

$('mic-select').addEventListener('change', (e) => {
  const option = e.currentTarget.selectedOptions[0];
  act('settings', { microphone: e.currentTarget.value ? { id: e.currentTarget.value, label: option.textContent } : null });
});

$('login-item').addEventListener('change', (e) => act('loginItem', e.currentTarget.checked));
$('update-open').addEventListener('click', () => state.update?.url && act('applyUpdate', undefined, $('update-open')));

$('unpair').addEventListener('click', async (e) => {
  if (!confirm('Desparear este computador? Você vai precisar de um código novo para conectar de novo.')) return;
  await act('settingsOpen', false);
  await act('unpair', undefined, e.currentTarget);
});

api.onState(render);
api.onTabs((value) => {
  tabs = value;
  if (state) render(state);
});
const first = await act('snapshot');
if (first) render(first);
api.loginItem().then((r) => { if (r.ok) $('login-item').checked = r.data; });
