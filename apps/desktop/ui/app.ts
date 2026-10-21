// The app's window: it only shows the state that comes from the main process and calls the actions. No text from outside goes in as HTML.
import type { Action, AgentStatus, ArgOf, DataOf, HardwareInfo, KaraokeBridge, OpenRoom, Result, Snapshot, Tabs, YoutubeStatus } from './bridge.ts';
import { engineInUse, gpuChoices as chooseGpu, kindOf, machineLine } from './gpu.ts';
import { renderStats } from './stats.ts';

const $ = (id: string) => document.getElementById(id)!;
const $input = (id: string) => $(id) as HTMLInputElement;
const $button = (id: string) => $(id) as HTMLButtonElement;
const $select = (id: string) => $(id) as HTMLSelectElement;
const api = (window as unknown as { karaoke: KaraokeBridge }).karaoke;

let state: Snapshot | null = null;
let importFile: string | null = null;
let autoStarted = false;
let checkedYoutube = false;
let tabs: Tabs = { tab: 'session', rooms: [], room: null, sub: 'tv', settings: false };
let hardwareInfo: HardwareInfo | null = null;

type Pill = readonly [text: string, kind: string];
const AGENT_TEXT: Record<AgentStatus['status'], Pill> = {
  stopped: ['Parada', ''],
  starting: ['Conectando…', 'warn'],
  online: ['Online', 'ok'],
  offline: ['Sem conexão', 'bad'],
  auth_error: ['Acesso recusado', 'bad'],
};
const YT_TEXT: Record<YoutubeStatus['status'], Pill> = { unknown: ['Não conectado', ''], connected: ['Conectado', 'ok'], 'not-logged': ['Não conectado', 'warn'] };

function showError(message: string) {
  const box = $('error');
  box.textContent = message || '';
  box.hidden = !message;
}

/** Calls an action of the main process; shows the error (if any) and answers the data or null. */
async function act<K extends Action>(name: K, arg?: ArgOf<K>, button?: HTMLButtonElement): Promise<DataOf<K> | null> {
  if (button) button.disabled = true;
  showError('');
  try {
    const result = await (api[name] as (arg?: ArgOf<K>) => Promise<Result<DataOf<K>>>)(arg);
    if (!result.ok) {
      if (result.error.code !== 'cancelled') showError(result.error.message);
      return null;
    }
    return result.data;
  } finally {
    if (button) button.disabled = false;
  }
}

/** Calls `handler` with the button when it is clicked. */
function onClick(id: string, handler: (button: HTMLButtonElement) => unknown) {
  const button = $button(id);
  button.addEventListener('click', () => handler(button));
}

function setPill(el: HTMLElement, [text, kind]: Pill) {
  el.textContent = text;
  el.className = `pill ${kind}`.trim();
}

const isRunning = (s: Snapshot) => s.agent.status !== 'stopped' && s.agent.status !== 'auth_error';

function render(s: Snapshot) {
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
  maybeLoadStats(!$('screen-home').hidden);
  $('screen-settings').hidden = !settings;
  $('tabs').hidden = !(paired && running);
  $('main').classList.toggle('full', paired && !running && !settings); // the start screen uses the whole window
  if (s.phase === 'engine' && s.engine.status === 'missing' && !autoStarted) { // the first time it opens: it starts by itself, without asking
    autoStarted = true;
    act('buildEngine', { engine: 'auto' });
  }
  if (paired && !running && s.youtube.status === 'unknown' && !checkedYoutube) { // logged in before? check quietly
    checkedYoutube = true;
    api.youtubeStatus();
  }

  // the update
  const u = s.update;
  $('update').hidden = !(u && (u.status === 'update_available' || u.status === 'update_required'));
  if (u && !$('update').hidden) {
    $('update-title').textContent = u.status === 'update_required' ? `Atualização necessária (versão ${u.minimum ?? u.latest} ou mais nova)` : `Há uma versão nova: ${u.latest}`;
    $('update-notes').textContent = u.notes ?? '';
    $('update-open').hidden = !u.url;
    const progress = s.updateProgress;
    $button('update-open').disabled = Boolean(progress);
    $('update-open').textContent = progress ? `Baixando… ${progress.percent}%` : 'Atualizar agora';
  }

  // installing the components (it also shows when the video card changes)
  const building = s.engine.status !== 'error';
  $('engine-build').hidden = building;
  $('engine-progress').hidden = !building;
  if (s.engine.progress) {
    const p = s.engine.progress;
    $('engine-label').textContent = p.label;
    const bar = $('engine-bar') as HTMLProgressElement;
    if (p.total) bar.value = Math.round(((p.done ?? 0) / p.total) * 100);
    else bar.removeAttribute('value');
  }
  $('engine-error').hidden = !s.engine.error;
  $('engine-error').textContent = s.engine.error ?? '';

  // the start screen (no Session)
  setPill($('yt-pill'), YT_TEXT[s.youtube.status] ?? ['?', '']);
  $('yt-login').textContent = s.youtube.status === 'connected' ? 'Trocar de conta' : 'Entrar no YouTube';
  const nickname = $input('welcome-nickname');
  if (document.activeElement !== nickname && !nickname.value) nickname.value = s.nickname ?? '';
  if (!$input('pair-server').value) $input('pair-server').value = s.defaultServer ?? '';
  $('welcome-server').textContent = s.server ? s.server.replace(/^https?:\/\//, '') : '';
  $('token-note').hidden = s.tokenProtected !== false;
  $('welcome-error').hidden = s.agent.status !== 'auth_error';
  $('welcome-error').textContent = s.agent.status === 'auth_error' ? s.agent.error ?? '' : '';

  // the Session under way
  const online = s.agent.status === 'online';
  const creating = s.busy === 'criando sala';
  setPill($('agent-pill'), AGENT_TEXT[s.agent.status] ?? ['?', '']);
  $('session-nick').textContent = s.nickname ?? '';
  $('cloud-note').hidden = !s.agent.cloud;
  $('agent-error').hidden = !s.agent.error;
  $('agent-error').textContent = s.agent.error ?? '';
  $button('room-create').disabled = !online || Boolean(s.busy);
  $('room-create-spinner').hidden = !creating;
  $('room-create-label').textContent = creating ? 'Criando a sala…' : 'Criar sala';
  $button('import-pick').disabled = Boolean(s.busy);
  $button('import-go').disabled = Boolean(s.busy);
  renderRooms(s.rooms, creating);

  // the settings
  setPill($('yt-pill-home'), YT_TEXT[s.youtube.status] ?? ['?', '']);
  $('library-home').textContent = s.libraryDir ?? '';
  $button('library-change').disabled = running;
  $('library-note').hidden = !running;
  $button('gpu-apply').disabled = running;
  $('gpu-note').hidden = !running;
  $('gpu-note').textContent = running ? 'Encerre a sessão para trocar a placa de vídeo.' : '';
  renderGpu();

  // waiting: the YouTube login
  const waiting = s.busy === 'login do YouTube';
  $('wait').hidden = !waiting;
  if (waiting) {
    $('wait-title').textContent = 'Aguardando conexão…';
    $('wait-text').textContent = `Entre na sua conta do YouTube na janela do ${s.browserName?.replace(/^o /, '') ?? 'navegador'} que foi aberta. Esta tela fecha sozinha quando a conexão for feita.`;
  }
  if (s.busy === 'importando música') $('import-result').textContent = 'Importando… (a primeira vez demora mais)';
  renderTabs();
}

function renderRooms(rooms: OpenRoom[], creating = false) {
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

/** "Salas" has the open Rooms and, in each, the TV and Host sub-tabs: the server's pages stay inside the window. */
function renderTabs() {
  if (!state) return;
  const running = isRunning(state) && state.phase === 'home';
  const inRooms = running && tabs.tab === 'rooms' && tabs.rooms.length > 0 && !tabs.settings;
  $('tab-session').classList.toggle('active', tabs.tab === 'session' || tabs.settings);
  $('tab-rooms').classList.toggle('active', tabs.tab === 'rooms' && !tabs.settings);
  $button('tab-rooms').disabled = tabs.rooms.length === 0;
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
  const web = inRooms; // with a Room open, the window shows only the header and the tabs (the Room's page takes the rest)
  $('main').hidden = web;
  reportLayout();
}

/** Tells the main process where the interface ends (the Rooms' pages begin right below). */
let lastTop = 0;
function reportLayout() {
  const top = Math.ceil($('chrome').getBoundingClientRect().bottom);
  if (top !== lastTop) {
    lastTop = top;
    api.layout(top);
  }
}
new ResizeObserver(reportLayout).observe($('chrome'));

// --- the settings ---
/** The video card choices (the settings and the first Session use the same list). */
function gpuChoices() {
  return chooseGpu(hardwareInfo, state?.engine.kind);
}

function renderGpu() {
  const select = $select('gpu-select');
  if (!state || $('screen-settings').hidden) return;
  if (document.activeElement === select) return;
  const { gpu, options, current, wanted } = gpuChoices();
  if (select.dataset.signature !== JSON.stringify(options) + wanted) {
    select.replaceChildren(...options.map(([value, label]) => Object.assign(document.createElement('option'), { value, textContent: label })));
    select.value = options.some(([value]) => value === wanted) ? wanted : 'auto';
    select.dataset.signature = JSON.stringify(options) + wanted;
  }
  $('gpu-info').textContent = `Em uso: ${engineInUse(current)}${state.engine.reason ? ` (${state.engine.reason})` : ''}. ${machineLine(hardwareInfo, gpu)}`;
}

async function loadMicrophones(select = $select('mic-select')) {
  let devices: MediaDeviceInfo[] = [];
  try {
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true }); // only so the browser shows the microphones' names
    probe.getTracks().forEach((track) => track.stop());
  } catch {
    /* no permission or no microphone: the list may come without names */
  }
  try {
    devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications');
  } catch {
    devices = [];
  }
  const chosen = state?.microphone?.id ?? '';
  const options = [{ value: '', label: 'Padrão do sistema' }, ...devices.map((d, i) => ({ value: d.deviceId, label: d.label || `Microfone ${i + 1}` }))];
  if (chosen && !options.some((o) => o.value === chosen)) options.push({ value: chosen, label: `${state?.microphone?.label || 'Microfone escolhido'} (desconectado)` });
  select.replaceChildren(...options.map((o) => Object.assign(document.createElement('option'), o.value === chosen ? { value: o.value, textContent: o.label, selected: true } : { value: o.value, textContent: o.label })));
  select.value = chosen;
}

/** The chosen microphone, or null for the system's default. */
function chosenMicrophone(select: HTMLSelectElement) {
  return select.value ? { id: select.value, label: select.selectedOptions[0]?.textContent ?? '' } : null;
}

async function openSettings() {
  await act('settingsOpen', true);
  hardwareInfo ??= await act('hardware');
  renderGpu();
  loadMicrophones();
}

// --- the actions ---
onClick('engine-build', (button) => act('buildEngine', { engine: 'auto' }, button));

onClick('pair-send', async (button) => {
  $('pair-sent').hidden = true;
  const data = await act('requestCode', { server: $input('pair-server').value, email: $input('pair-email').value }, button);
  if (data) {
    $('pair-sent').hidden = false;
    $('pair-sent').textContent = data.message;
    $('pair-code').focus();
  }
});
$('pair-email').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('pair-send').click(); });
$('pair-code').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('pair-go').click(); });

onClick('pair-go', async (button) => {
  const data = await act('pair', { server: $input('pair-server').value, code: $input('pair-code').value, name: $input('pair-name').value }, button);
  if (data) $input('pair-code').value = '';
});

// the first Session on this computer: before it starts, the person chooses the video card and the microphone
async function openSetup() {
  hardwareInfo ??= await act('hardware');
  const { gpu, options, wanted } = gpuChoices();
  const select = $select('setup-gpu');
  select.replaceChildren(...options.map(([value, label]) => Object.assign(document.createElement('option'), { value, textContent: label })));
  select.value = wanted;
  $('setup-gpu-info').textContent = hardwareInfo ? `${machineLine(hardwareInfo, gpu)}. Trocar a placa reinstala parte dos componentes e leva alguns minutos.` : '';
  $('setup').hidden = false;
  await loadMicrophones($select('setup-mic'));
}

onClick('welcome-start', async (button) => {
  const nickname = $input('welcome-nickname').value;
  if (state?.setupDone || !nickname.trim()) return act('startAgent', { nickname }, button); // without a nickname the controller explains
  button.disabled = true;
  try {
    await openSetup();
  } finally {
    button.disabled = false;
  }
});
onClick('setup-cancel', () => { $('setup').hidden = true; });
onClick('setup-go', async (button) => {
  const kind = $select('setup-gpu').value;
  const { current } = gpuChoices();
  await act('settings', { microphone: chosenMicrophone($select('setup-mic')), setupDone: true }, button);
  $('setup').hidden = true;
  if (kind !== 'auto' && kind !== kindOf(current)) {
    await act('buildEngine', { engine: kind, switchEngine: true }); // reinstalls the engine; the Session starts on the next click
    return;
  }
  await act('startAgent', { nickname: $input('welcome-nickname').value });
});
$('welcome-nickname').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('welcome-start').click(); });
onClick('session-toggle', (button) => act('stopAgent', undefined, button));
onClick('room-create', async (button) => {
  const room = await act('createRoom', undefined, button);
  if (room) act('openRoom', room.code); // the new Room opens right away, on the TV
});

for (const button of document.querySelectorAll<HTMLButtonElement>('.tab[data-tab]')) button.addEventListener('click', () => act('selectTab', button.dataset.tab ?? ''));
for (const button of document.querySelectorAll<HTMLButtonElement>('.subtab[data-sub]')) button.addEventListener('click', () => act('selectSub', button.dataset.sub ?? ''));
onClick('gear', () => (tabs.settings ? act('settingsOpen', false) : openSettings()));
onClick('settings-back', () => act('settingsOpen', false));

onClick('import-pick', async () => {
  const file = await act('pickAudio');
  if (!file) return;
  importFile = file;
  $('import-file').textContent = file;
  $('import-form').hidden = false;
  $('import-result').hidden = true;
});

onClick('import-go', async (button) => {
  $('import-result').hidden = false;
  $('import-result').textContent = 'Importando… (a primeira vez demora mais)';
  const data = await act('importFile', { file: importFile ?? '', artist: $input('import-artist').value.trim(), title: $input('import-title').value.trim() }, button);
  $('import-result').textContent = data ? data.message : '';
  if (data) {
    $('import-form').hidden = true;
    $input('import-artist').value = '';
    $input('import-title').value = '';
    importFile = null;
  }
});

// the login opens the system's DEFAULT browser, after asking (the notice comes from the main process)
onClick('yt-login', (button) => act('youtubeLogin', undefined, button));
onClick('yt-login-home', (button) => act('youtubeLogin', undefined, button));
onClick('yt-check', (button) => act('youtubeStatus', undefined, button));
onClick('wait-cancel', () => act('cancelBusy'));

onClick('library-change', async () => {
  const dir = await act('pickFolder');
  if (dir) await act('setLibrary', dir);
});

onClick('gpu-apply', async (button) => {
  const kind = $select('gpu-select').value;
  const current = kindOf(state?.engine.kind);
  if (kind !== 'auto' && kind === current) return;
  if (!confirm('Trocar a placa de vídeo? O aplicativo vai reinstalar parte dos componentes.')) return;
  await act('settingsOpen', false);
  await act('buildEngine', { engine: kind, switchEngine: true }, button);
});

$('mic-select').addEventListener('change', () => act('settings', { microphone: chosenMicrophone($select('mic-select')) }));

$('login-item').addEventListener('change', () => act('loginItem', $input('login-item').checked));
onClick('update-open', (button) => state?.update?.url && act('applyUpdate', undefined, button));

onClick('unpair', async (button) => {
  if (!confirm('Desparear este computador? Você vai precisar de um código novo para conectar de novo.')) return;
  await act('settingsOpen', false);
  await act('unpair', undefined, button);
});

// the owner's statistics: they load when the Session tab shows and when the period changes
async function loadStats() {
  const box = $('stats-body');
  $('stats-error').hidden = true;
  const result = await api.stats({ days: Number($select('stats-days').value) });
  if (!result.ok) {
    $('stats-error').textContent = result.error.message;
    $('stats-error').hidden = false;
    return;
  }
  renderStats(box, result.data);
}
$('stats-days').addEventListener('change', loadStats);
$('stats-refresh').addEventListener('click', loadStats);
let statsLoaded = false;
function maybeLoadStats(visible: boolean) {
  if (visible && !statsLoaded) {
    statsLoaded = true;
    loadStats();
  }
  if (!visible) statsLoaded = false; // leaving the tab: the next visit fetches again
}

api.onState(render);
api.onTabs((value) => {
  tabs = value;
  if (state) render(state);
});
const first = await act('snapshot');
if (first) render(first);
api.loginItem().then((r) => { if (r.ok) $input('login-item').checked = r.data; });
