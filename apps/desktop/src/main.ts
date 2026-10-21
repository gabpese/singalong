// Electron's main process: it opens the window and the tray, and wires the window to the controller (src/controller.ts).
// The window has the app's interface (the "Session" and "Rooms" tabs) and, inside a Room, the server's pages embedded.
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, safeStorage, session as electronSession, shell, Tray, WebContentsView } from 'electron';
import electronUpdater from 'electron-updater';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Action, ArgOf, DataOf, Snapshot, Tabs } from '../ui/bridge.ts';
import { BROWSER_NAMES, createController, type Launcher, UserError, type Vault } from './controller.ts';
import { installerUrl, needsNoSandbox } from './installers.ts';

const here = dirname(fileURLToPath(import.meta.url));
const testMode = process.env.SINGALONG_DESKTOP_TEST === '1';
const ICON = join(here, '..', 'ui', 'icon.png');

if (process.env.SINGALONG_USER_DATA) app.setPath('userData', process.env.SINGALONG_USER_DATA);
if (!testMode && !app.requestSingleInstanceLock()) app.quit();
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required'); // the TV plays without a click
if (needsNoSandbox({ read: (path) => readFileSync(path, 'utf8') })) app.commandLine.appendSwitch('no-sandbox'); // an AppImage on a distribution that restricts namespaces (see src/installers.ts)

let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

// In the end-to-end tests the engine is the development environment's Python (SINGALONG_TEST_PYTHON) instead of the assembled engine.
const testPython = process.env.SINGALONG_TEST_PYTHON;
const launcher: Launcher | undefined = testPython
  ? (_root, args, extraEnv) => [
      testPython,
      ['-m', 'singalong_worker', ...args],
      { cwd: process.env.SINGALONG_TEST_WORKER_DIR, env: { ...process.env, PYTHONPATH: process.env.SINGALONG_TEST_WORKER_DIR, PYTHONUTF8: '1', ...extraEnv }, windowsHide: true },
    ]
  : undefined;

const { autoUpdater } = electronUpdater;

/**
 * The system vault for the device token: DPAPI on Windows, the Keychain on macOS, the Secret Service on Linux. Only usable
 * once the app is ready. On Linux without a Secret Service, Electron falls back to a fixed key (`basic_text`): the token is
 * then not protected, and the window says so.
 */
async function systemVault(): Promise<Vault> {
  const available = await safeStorage.isAsyncEncryptionAvailable();
  const fixedKey = process.platform === 'linux' && safeStorage.getSelectedStorageBackend() === 'basic_text';
  return {
    available,
    protects: available && !fixedKey,
    encrypt: async (text) => (await safeStorage.encryptStringAsync(text)).toString('base64'),
    decrypt: async (sealed) => {
      const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(Buffer.from(sealed, 'base64'));
      return { text: result, reEncrypt: shouldReEncrypt };
    },
  };
}

const controller = createController({
  dataDir: app.getPath('userData'),
  version: app.getVersion(),
  openVault: systemVault,
  // installed: the worker's code is in the installer's resources; in development the default (apps/worker) holds
  ...(app.isPackaged ? { workerSource: join(process.resourcesPath, 'worker') } : {}),
  emit: (event, payload) => {
    win?.webContents.send(`sg:${event}`, payload);
    if (event === 'state' && (payload as Snapshot).agent.status === 'stopped' && roomViews.size) closeAllRooms();
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

/** Opens in the browser only the paired server's addresses (the Room, the TV) or the update's download link. */
function allowedExternal(url: string) {
  try {
    const target = new URL(url);
    const state = controller.snapshot();
    const origins = [serverOrigin(), state.update?.url && new URL(state.update.url).origin].filter(Boolean);
    return ['https:', 'http:'].includes(target.protocol) && origins.includes(target.origin);
  } catch {
    return false;
  }
}

// --- the tabs: "Session" and "Rooms"; inside a Room, the "TV" and "Host" sub-tabs (the server's pages inside the window) ---
const TABBAR_FALLBACK = 96;
const roomViews = new Map<string, { tv: WebContentsView; host: WebContentsView }>(); // the Room's code → its pages
let activeTab: Tabs['tab'] = 'session';
let activeRoom: string | null = null;
let activeSub: Tabs['sub'] = 'tv'; // entering a Room opens the TV by default
let htmlFullscreen = false; // the Room's page (its fullscreen icon) asked for fullscreen: it covers the whole window
let settingsOpen = false; // the settings screen covers the pages
let top = TABBAR_FALLBACK; // where the interface ends and the pages begin (the interface says)

function sendTabs() {
  const tabs: Tabs = { tab: activeTab, rooms: [...roomViews.keys()], room: activeRoom, sub: activeSub, settings: settingsOpen };
  win?.webContents.send('sg:tabs', tabs);
}

function layout() {
  if (!win) return;
  const [width, height] = win.getContentSize();
  for (const [code, views] of roomViews) {
    for (const sub of ['tv', 'host'] as const) {
      views[sub].setBounds({ x: 0, y: htmlFullscreen ? 0 : top, width, height: Math.max(0, height - (htmlFullscreen ? 0 : top)) });
      views[sub].setVisible(!settingsOpen && activeTab === 'rooms' && code === activeRoom && sub === activeSub);
    }
  }
}

function newRoomView(window: BrowserWindow, url: string) {
  const view = new WebContentsView({
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, partition: 'persist:sala', preload: join(here, 'room-preload.cjs') },
  });
  view.setBackgroundColor('#0b0b14');
  const origin = new URL(url).origin;
  view.webContents.setWindowOpenHandler(({ url: target }) => {
    if (target.startsWith(origin)) shell.openExternal(target); // the server's own links open in the browser; the rest is ignored
    return { action: 'deny' };
  });
  view.webContents.on('will-navigate', (event, target) => {
    if (new URL(target).origin !== origin) event.preventDefault();
  });
  // the page's own fullscreen icon: the whole window goes fullscreen and the page covers it all (Esc or the icon leave)
  view.webContents.on('enter-html-full-screen', () => { htmlFullscreen = true; window.setFullScreen(true); layout(); });
  view.webContents.on('leave-html-full-screen', () => { htmlFullscreen = false; window.setFullScreen(false); layout(); });
  view.webContents.loadURL(url);
  window.contentView.addChildView(view);
  return view;
}

function destroyRoom(code: string) {
  const views = roomViews.get(code);
  if (!views) return;
  for (const view of [views.tv, views.host]) {
    win?.contentView.removeChildView(view);
    view.webContents.close();
  }
  roomViews.delete(code);
}

function closeRoom(code: string) {
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

function openRoom(code: string) {
  const room = controller.snapshot().rooms.find((r) => r.code === code);
  if (!room || !win) throw new UserError('no_room', 'Sala não encontrada.');
  if (!roomViews.has(code)) roomViews.set(code, { tv: newRoomView(win, room.tv), host: newRoomView(win, room.host) });
  activeTab = 'rooms';
  activeRoom = code;
  activeSub = 'tv'; // entering a Room opens the TV
  settingsOpen = false;
  layout();
  sendTabs();
}

function selectTab(tab: string) {
  if (tab === 'rooms' && !roomViews.size) return;
  if (tab !== 'session' && tab !== 'rooms') return;
  activeTab = tab;
  settingsOpen = false;
  layout();
  sendTabs();
}

function selectRoom(code: string) {
  if (!roomViews.has(code)) return;
  activeRoom = code;
  activeTab = 'rooms';
  layout();
  sendTabs();
}

function selectSub(sub: string) {
  if (sub !== 'tv' && sub !== 'host') return;
  activeSub = sub;
  layout();
  sendTabs();
}

function setSettingsOpen(open: unknown) {
  settingsOpen = Boolean(open);
  layout();
  sendTabs();
}

/**
 * Every action answers `{ ok, data }` or `{ ok: false, error: { code, message } }`: the window never gets a raw exception.
 * The argument comes from the window, typed by the contract (ui/bridge.ts) but checked again by whoever uses it.
 */
function handle<K extends Action>(channel: K, fn: (arg: ArgOf<K>) => DataOf<K> | Promise<DataOf<K>>) {
  ipcMain.handle(`sg:${channel}`, async (_event, arg: ArgOf<K>) => {
    try {
      return { ok: true, data: await fn(arg) };
    } catch (error) {
      if (!(error instanceof UserError)) console.error(`[${channel}]`, error);
      return { ok: false, error: { code: (error as { code?: string } | null)?.code ?? 'internal', message: error instanceof UserError ? error.message : 'Algo deu errado. Tente de novo.' } };
    }
  });
}

/**
 * Updates the app: `update.url` (the server's APP_DOWNLOAD_URL) is the folder that has the installer and latest.yml. It
 * downloads, checks latest.yml's hash, ends the Session and installs. Without latest.yml (or in development) it opens the link in
 * the browser.
 */
async function applyUpdate() {
  const info = controller.snapshot().update;
  if (!info?.url || !allowedExternal(info.url)) throw new UserError('no_update', 'Não há atualização para baixar.');
  if (!app.isPackaged && !process.env.SINGALONG_UPDATER_DEV) {
    await shell.openExternal(info.url);
    return { opened: true };
  }
  if (process.platform === 'darwin') {
    // the Mac app has no Apple signature: macOS refuses to swap an app without one by itself, so updating means downloading the new DMG
    const link = installerUrl(info.url);
    if (!allowedExternal(link)) throw new UserError('no_update', 'Não há atualização para baixar.');
    await shell.openExternal(link);
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
    await shell.openExternal(info.url); // without the automatic update file: the manual download still holds
    return { opened: true };
  }
  if (!found?.isUpdateAvailable) throw new UserError('no_update', 'Você já está com a versão mais recente.');
  controller.setUpdateProgress({ percent: 0 });
  try {
    await autoUpdater.downloadUpdate();
  } catch (error) {
    controller.setUpdateProgress(null);
    throw new UserError('update_failed', `Não consegui baixar a atualização (${(error as Error).message}).`);
  }
  await controller.stopAgent(); // ends the Session on the server before the installer closes the app
  quitting = true;
  if (process.env.SINGALONG_UPDATER_DEV) return { downloaded: true }; // the tests check the download without restarting
  autoUpdater.quitAndInstall(true, true);
  return { installing: true };
}

/** Asks before opening the user's browser for the login (the automatic test skips the question). */
async function confirmBrowserLogin() {
  if (testMode) return true;
  const name = BROWSER_NAMES[controller.snapshot().browser];
  const options: Electron.MessageBoxOptions = {
    type: 'question',
    buttons: ['Abrir o navegador', 'Cancelar'],
    defaultId: 0,
    cancelId: 1,
    title: 'Entrar no YouTube',
    message: `O Singalong vai abrir ${name} para você entrar na sua conta do YouTube.`,
    detail: 'Uma janela separada será aberta, só para o Singalong. Entre normalmente; quando terminar, ela fecha sozinha. A sua senha não passa por este aplicativo.',
  };
  const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options);
  return response === 0;
}

/** Picks a file or a folder (in the automatic test, the answer comes from the environment). */
async function pick(options: Electron.OpenDialogOptions) {
  const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
  return result.canceled ? null : (result.filePaths[0] ?? null);
}

function registerIpc() {
  handle('snapshot', () => controller.snapshot());
  handle('buildEngine', (arg) => controller.buildEngine(arg));
  handle('pair', (arg) => controller.pair(arg));
  handle('requestCode', (arg) => controller.requestCode(arg));
  handle('unpair', () => controller.unpair());
  handle('startAgent', (arg) => controller.startAgent(arg));
  handle('stopAgent', () => controller.stopAgent());
  handle('createRoom', () => controller.createRoom());
  handle('youtubeLogin', async () => {
    if (!(await confirmBrowserLogin())) return { cancelled: true } as const;
    return controller.youtubeLogin();
  });
  handle('cancelBusy', () => controller.cancelBusy());
  handle('youtubeStatus', () => controller.youtubeStatus());
  handle('importFile', (arg) => controller.importFile(arg));
  handle('hardware', () => controller.hardware());
  handle('stats', (arg) => controller.stats(arg));
  handle('settings', async (arg) => {
    const snapshot = await controller.setSettings(arg);
    if (arg?.microphone !== undefined) for (const views of roomViews.values()) views.tv.webContents.reload(); // the TV switches to the new microphone
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
  handle('pickAudio', async () => {
    if (testMode && process.env.SINGALONG_TEST_PICK) return process.env.SINGALONG_TEST_PICK;
    return pick({ title: 'Escolha uma música', properties: ['openFile'], filters: [{ name: 'Áudio', extensions: ['mp3', 'flac', 'wav', 'm4a', 'ogg', 'opus'] }] });
  });
  handle('pickFolder', async () => {
    if (testMode && process.env.SINGALONG_TEST_FOLDER) return process.env.SINGALONG_TEST_FOLDER;
    return pick({ title: 'Onde guardar as músicas', properties: ['openDirectory', 'createDirectory'], defaultPath: controller.snapshot().libraryDir });
  });
  handle('setLibrary', (dir) => controller.setLibraryDir(dir));
}

/** The server's pages (the TV needs the microphone, fullscreen and access to the local media server) get only these permissions. */
function allowRoomPermissions() {
  const allowed = new Set(['media', 'fullscreen', 'clipboard-sanitized-write', 'local-network-access', 'local-network', 'loopback-network']); // clipboard: the copy-link buttons
  const room = electronSession.fromPartition('persist:sala');
  const fromServer = (url: string) => {
    try {
      return new URL(url).origin === serverOrigin();
    } catch {
      return false;
    }
  };
  room.setPermissionRequestHandler((contents, permission, callback) => callback(allowed.has(permission) && fromServer(contents.getURL())));
  room.setPermissionCheckHandler((_contents, permission, origin) => allowed.has(permission) && fromServer(origin));
}

function createWindow() {
  const window = new BrowserWindow({
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
  win = window;
  window.setMenuBarVisibility(false); // on macOS the app's menu stays (it gives Cmd+C and Cmd+V in the fields)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); // links never open Electron windows
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  // the window comes back from the tray: check whether a new version came out (the app may stay open for days)
  window.on('show', () => controller.refreshUpdate().catch(() => {}));
  window.on('focus', () => controller.refreshUpdate().catch(() => {}));
  window.on('resize', layout);
  window.on('enter-full-screen', layout);
  window.on('leave-full-screen', layout);
  window.loadFile(join(here, '..', 'ui', 'index.html'));
  window.on('close', (event) => {
    // with the Session running, closing the window only hides it (the karaoke goes on from the tray)
    if (!quitting && controller.snapshot().agent.status !== 'stopped') {
      event.preventDefault();
      window.hide();
    }
  });
  return window;
}

function createTray() {
  tray = new Tray(nativeImage.createFromPath(ICON));
  tray.setToolTip('Singalong Karaoke');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir', click: showWindow },
    { label: 'Sair', click: () => app.quit() },
  ]));
  tray.on('click', showWindow);
}

/** Brings the window back; if it was really closed (the Session stopped), opens another. */
function showWindow() {
  if (!app.isReady()) return; // a second launch too early (the first instance is still starting)
  const window = !win || win.isDestroyed() ? createWindow() : win;
  window.show();
  window.focus();
}

app.whenReady().then(async () => {
  registerIpc();
  allowRoomPermissions();
  await controller.init();
  createWindow();
  if (!testMode) createTray();
});

app.on('second-instance', showWindow);
app.on('activate', showWindow); // macOS: the click on the Dock icon
app.on('window-all-closed', () => { if (quitting) app.quit(); });
app.on('before-quit', (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault(); // ends the Session on the server before quitting
  controller.stopAgent().finally(() => app.quit());
});
