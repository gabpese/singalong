// Processo principal do Electron: abre a janela, a bandeja e liga a interface ao controlador (src/controller.js).
// A janela tem a interface do app (abas "Sessão", "Anfitrião" e "TV") e, nas duas últimas, páginas do servidor embutidas.
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, session as electronSession, shell, Tray, WebContentsView } from 'electron';
import electronUpdater from 'electron-updater';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BROWSER_NAMES, createController, UserError } from './controller.js';

const here = dirname(fileURLToPath(import.meta.url));
const testMode = process.env.SINGALONG_DESKTOP_TEST === '1';
const ICON = join(here, '..', 'ui', 'icon.png');

if (process.env.SINGALONG_USER_DATA) app.setPath('userData', process.env.SINGALONG_USER_DATA);
if (!testMode && !app.requestSingleInstanceLock()) app.quit();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required'); // a TV toca sem precisar de um clique

let win = null;
let tray = null;
let quitting = false;

// Nos testes de ponta a ponta o motor é o Python do ambiente de desenvolvimento (SINGALONG_TEST_PYTHON) em vez do motor montado.
const launcher = process.env.SINGALONG_TEST_PYTHON
  ? (root, args, extraEnv) => [
      process.env.SINGALONG_TEST_PYTHON,
      ['-m', 'singalong_worker', ...args],
      { cwd: process.env.SINGALONG_TEST_WORKER_DIR, env: { ...process.env, PYTHONPATH: process.env.SINGALONG_TEST_WORKER_DIR, PYTHONUTF8: '1', ...extraEnv }, windowsHide: true },
    ]
  : undefined;

const { autoUpdater } = electronUpdater;

const controller = createController({
  dataDir: app.getPath('userData'),
  version: app.getVersion(),
  // instalado: o código do worker vai nos recursos do instalador; em desenvolvimento vale o padrão (apps/worker)
  ...(app.isPackaged ? { workerSource: join(process.resourcesPath, 'worker') } : {}),
  emit: (event, payload) => {
    win?.webContents.send(`sg:${event}`, payload);
    if (event === 'state' && payload.agent.status === 'stopped' && roomViews.size) closeAllRooms();
  },
  ...(launcher ? { launcher } : {}),
});

const serverOrigin = () => {
  try {
    return new URL(controller.snapshot().server).origin;
  } catch {
    return null;
  }
};

/** Só abre no navegador endereços do servidor pareado (a sala, a TV) ou o link de download da atualização. */
function allowedExternal(url) {
  try {
    const target = new URL(url);
    const state = controller.snapshot();
    const origins = [serverOrigin(), state.update?.url && new URL(state.update.url).origin].filter(Boolean);
    return ['https:', 'http:'].includes(target.protocol) && origins.includes(target.origin);
  } catch {
    return false;
  }
}

// --- abas: "Sessão" e "Salas"; dentro de uma sala, as sub-abas "TV" e "Anfitrião" (páginas do servidor dentro da janela) ---
const TABBAR_FALLBACK = 96;
const roomViews = new Map(); // código da sala → { tv, host }
let activeTab = 'session'; // session | rooms
let activeRoom = null;
let activeSub = 'tv'; // o padrão ao entrar numa sala é o modo TV
let settingsOpen = false; // a tela de configurações cobre as páginas
let top = TABBAR_FALLBACK; // onde a interface termina e as páginas começam (a interface informa)

function sendTabs() {
  win?.webContents.send('sg:tabs', { tab: activeTab, rooms: [...roomViews.keys()], room: activeRoom, sub: activeSub, settings: settingsOpen });
}

function layout() {
  if (!win) return;
  const [width, height] = win.getContentSize();
  for (const [code, views] of roomViews) {
    for (const sub of ['tv', 'host']) {
      views[sub].setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
      views[sub].setVisible(!settingsOpen && activeTab === 'rooms' && code === activeRoom && sub === activeSub);
    }
  }
}

function newRoomView(url) {
  const view = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'persist:sala', preload: join(here, 'room-preload.cjs') },
  });
  view.setBackgroundColor('#0b0b14');
  const origin = new URL(url).origin;
  view.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith(origin)) shell.openExternal(target); // links do próprio servidor abrem no navegador; o resto é ignorado
    return { action: 'deny' };
  });
  view.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin !== origin) event.preventDefault();
  });
  view.webContents.loadURL(url);
  win.contentView.addChildView(view);
  return view;
}

function destroyRoom(code) {
  const views = roomViews.get(code);
  if (!views) return;
  for (const view of [views.tv, views.host]) {
    win?.contentView.removeChildView(view);
    view.webContents.close();
  }
  roomViews.delete(code);
}

function closeRoom(code) {
  destroyRoom(code);
  if (activeRoom === code) {
    activeRoom = [...roomViews.keys()].at(-1) ?? null;
    if (!activeRoom) activeTab = 'session';
  }
  if (!roomViews.size && win?.isFullScreen()) win.setFullScreen(false);
  layout();
  sendTabs();
}

function closeAllRooms() {
  for (const code of [...roomViews.keys()]) destroyRoom(code);
  activeRoom = null;
  activeTab = 'session';
  if (win?.isFullScreen()) win.setFullScreen(false);
  sendTabs();
}

function openRoom(code) {
  const room = controller.snapshot().rooms.find((r) => r.code === code);
  if (!room) throw new UserError('no_room', 'Sala não encontrada.');
  if (!roomViews.has(code)) roomViews.set(code, { tv: newRoomView(room.tv), host: newRoomView(room.host) });
  activeTab = 'rooms';
  activeRoom = code;
  activeSub = 'tv'; // entrar numa sala abre o modo TV
  settingsOpen = false;
  layout();
  sendTabs();
}

function selectTab(tab) {
  if (tab === 'rooms' && !roomViews.size) return;
  if (!['session', 'rooms'].includes(tab)) return;
  activeTab = tab;
  settingsOpen = false;
  layout();
  sendTabs();
}

function selectRoom(code) {
  if (!roomViews.has(code)) return;
  activeRoom = code;
  activeTab = 'rooms';
  layout();
  sendTabs();
}

function selectSub(sub) {
  if (!['tv', 'host'].includes(sub)) return;
  activeSub = sub;
  layout();
  sendTabs();
}

function setSettingsOpen(open) {
  settingsOpen = Boolean(open);
  layout();
  sendTabs();
}

/** Todo método devolve { ok, data } ou { ok:false, error:{code,message} }: a janela nunca recebe uma exceção crua. */
function handle(channel, fn) {
  ipcMain.handle(`sg:${channel}`, async (_event, arg) => {
    try {
      return { ok: true, data: await fn(arg) };
    } catch (error) {
      if (!(error instanceof UserError)) console.error(`[${channel}]`, error);
      return { ok: false, error: { code: error.code ?? 'internal', message: error instanceof UserError ? error.message : 'Algo deu errado. Tente de novo.' } };
    }
  });
}

/**
 * Atualiza o app: `update.url` (APP_DOWNLOAD_URL do servidor) é a pasta que tem o instalador e o latest.yml. Baixa, confere o
 * hash do latest.yml, encerra a sessão e instala. Sem latest.yml (ou em desenvolvimento) abre o link no navegador.
 */
async function applyUpdate() {
  const info = controller.snapshot().update;
  if (!info?.url || !allowedExternal(info.url)) throw new UserError('no_update', 'Não há atualização para baixar.');
  if (!app.isPackaged && !process.env.SINGALONG_UPDATER_DEV) {
    await shell.openExternal(info.url);
    return { opened: true };
  }
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowDowngrade = false;
  if (process.env.SINGALONG_UPDATER_DEV) autoUpdater.forceDevUpdateConfig = true;
  autoUpdater.setFeedURL({ provider: 'generic', url: info.url.endsWith('/') ? info.url : `${info.url}/` });
  autoUpdater.on('download-progress', (progress) => controller.setUpdateProgress({ percent: Math.round(progress.percent) }));
  let found;
  try {
    found = await autoUpdater.checkForUpdates();
  } catch {
    await shell.openExternal(info.url); // sem o arquivo de atualização automática: o download manual continua valendo
    return { opened: true };
  }
  if (!found?.isUpdateAvailable) throw new UserError('no_update', 'Você já está com a versão mais recente.');
  controller.setUpdateProgress({ percent: 0 });
  try {
    await autoUpdater.downloadUpdate();
  } catch (error) {
    controller.setUpdateProgress(null);
    throw new UserError('update_failed', `Não consegui baixar a atualização (${error.message}).`);
  }
  await controller.stopAgent(); // encerra a sessão no servidor antes de o instalador fechar o app
  quitting = true;
  if (process.env.SINGALONG_UPDATER_DEV) return { downloaded: true }; // os testes conferem o download sem reiniciar
  autoUpdater.quitAndInstall(true, true);
  return { installing: true };
}

/** Pede licença antes de abrir o navegador do usuário para o login (no teste automático a pergunta é pulada). */
async function confirmBrowserLogin() {
  if (testMode) return true;
  const name = BROWSER_NAMES[controller.snapshot().browser];
  const { response } = await dialog.showMessageBox(win, {
    type: 'question',
    buttons: ['Abrir o navegador', 'Cancelar'],
    defaultId: 0,
    cancelId: 1,
    title: 'Entrar no YouTube',
    message: `O Singalong vai abrir ${name} para você entrar na sua conta do YouTube.`,
    detail: 'Uma janela separada será aberta, só para o Singalong. Entre normalmente; quando terminar, ela fecha sozinha. A sua senha não passa por este aplicativo.',
  });
  return response === 0;
}

function registerIpc() {
  handle('snapshot', () => controller.snapshot());
  handle('buildEngine', (arg) => controller.buildEngine(arg));
  handle('pair', (arg) => controller.pair(arg));
  handle('unpair', () => controller.unpair());
  handle('startAgent', (arg) => controller.startAgent(arg));
  handle('stopAgent', () => controller.stopAgent());
  handle('createRoom', () => controller.createRoom());
  handle('youtubeLogin', async () => {
    if (!(await confirmBrowserLogin())) return { cancelled: true };
    return controller.youtubeLogin();
  });
  handle('cancelBusy', () => controller.cancelBusy());
  handle('youtubeStatus', () => controller.youtubeStatus());
  handle('importFile', (arg) => controller.importFile(arg));
  handle('hardware', () => controller.hardware());
  handle('settings', async (arg) => {
    const snapshot = await controller.setSettings(arg);
    if (arg?.microphone !== undefined) for (const views of roomViews.values()) views.tv.webContents.reload(); // a TV passa a usar o microfone novo
    return snapshot;
  });
  handle('checkUpdate', () => controller.checkUpdate());
  handle('applyUpdate', () => applyUpdate());
  handle('loginItem', (enabled) => {
    if (typeof enabled === 'boolean') app.setLoginItemSettings({ openAtLogin: enabled });
    return app.getLoginItemSettings().openAtLogin;
  });
  handle('open', async (url) => {
    if (!allowedExternal(url)) throw new UserError('bad_url', 'Endereço não permitido.');
    await shell.openExternal(url);
  });
  handle('openRoom', (code) => openRoom(String(code)));
  handle('selectTab', (tab) => selectTab(tab));
  handle('selectRoom', (code) => selectRoom(String(code)));
  handle('selectSub', (sub) => selectSub(sub));
  handle('closeRoom', (code) => closeRoom(String(code)));
  handle('settingsOpen', (open) => setSettingsOpen(open));
  ipcMain.on('sg:mic-id', (event) => { event.returnValue = controller.snapshot().microphone?.id ?? ''; });
  handle('layout', (value) => {
    top = Math.max(0, Math.min(400, Math.round(Number(value) || TABBAR_FALLBACK)));
    layout();
  });
  handle('fullscreen', () => {
    win.setFullScreen(!win.isFullScreen());
    return win.isFullScreen();
  });
  handle('pickAudio', async () => {
    if (testMode && process.env.SINGALONG_TEST_PICK) return process.env.SINGALONG_TEST_PICK;
    const result = await dialog.showOpenDialog(win, {
      title: 'Escolha uma música',
      properties: ['openFile'],
      filters: [{ name: 'Áudio', extensions: ['mp3', 'flac', 'wav', 'm4a', 'ogg', 'opus'] }],
    });
    return result.canceled ? null : result.filePaths[0];
  });
  handle('pickFolder', async () => {
    if (testMode && process.env.SINGALONG_TEST_FOLDER) return process.env.SINGALONG_TEST_FOLDER;
    const result = await dialog.showOpenDialog(win, { title: 'Onde guardar as músicas', properties: ['openDirectory', 'createDirectory'], defaultPath: controller.snapshot().libraryDir });
    return result.canceled ? null : result.filePaths[0];
  });
  handle('setLibrary', (dir) => controller.setLibraryDir(dir));
}

/** As páginas do servidor (a TV precisa de microfone, tela cheia e acesso ao servidor de mídia local) só recebem essas licenças. */
function allowRoomPermissions() {
  const allowed = new Set(['media', 'fullscreen', 'local-network-access', 'local-network', 'loopback-network']);
  const room = electronSession.fromPartition('persist:sala');
  const fromServer = (url) => {
    try {
      return new URL(url).origin === serverOrigin();
    } catch {
      return false;
    }
  };
  room.setPermissionRequestHandler((contents, permission, callback) => callback(allowed.has(permission) && fromServer(contents.getURL())));
  room.setPermissionCheckHandler((contents, permission, origin) => allowed.has(permission) && fromServer(origin));
}

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 700,
    minHeight: 540,
    show: !process.env.SINGALONG_START_HIDDEN,
    title: 'Singalong Karaoke',
    icon: ICON,
    backgroundColor: '#14141c',
    webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); // links nunca abrem janelas do Electron
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.on('resize', layout);
  win.on('enter-full-screen', layout);
  win.on('leave-full-screen', layout);
  win.loadFile(join(here, '..', 'ui', 'index.html'));
  win.on('close', (event) => {
    // com a sessão rodando, fechar a janela só esconde (o karaokê continua pela bandeja)
    if (!quitting && controller.snapshot().agent.status !== 'stopped') {
      event.preventDefault();
      win.hide();
    }
  });
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON));
  tray.setToolTip('Singalong Karaoke');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir', click: () => { win.show(); win.focus(); } },
    { label: 'Sair', click: () => app.quit() },
  ]));
  tray.on('click', () => { win.show(); win.focus(); });
}

app.whenReady().then(async () => {
  registerIpc();
  allowRoomPermissions();
  await controller.init();
  createWindow();
  if (!testMode) createTray();
});

app.on('second-instance', () => { if (win) { win.show(); win.focus(); } });
app.on('window-all-closed', () => { if (quitting) app.quit(); });
app.on('before-quit', (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault(); // encerra a sessão no servidor antes de sair
  controller.stopAgent().finally(() => app.quit());
});
