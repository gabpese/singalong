// Processo principal do Electron: abre a janela, a bandeja e liga a interface ao controlador (src/controller.js).
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createController, UserError } from './controller.js';

const here = dirname(fileURLToPath(import.meta.url));
const testMode = process.env.SINGALONG_DESKTOP_TEST === '1';

if (process.env.SINGALONG_USER_DATA) app.setPath('userData', process.env.SINGALONG_USER_DATA);
if (!testMode && !app.requestSingleInstanceLock()) app.quit();

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

const controller = createController({
  dataDir: app.getPath('userData'),
  emit: (event, payload) => win?.webContents.send(`sg:${event}`, payload),
  ...(launcher ? { launcher } : {}),
});

/** Só abre no navegador endereços do servidor pareado (a sala, a TV) ou o link de download da atualização. */
function allowedExternal(url) {
  try {
    const target = new URL(url);
    const state = controller.snapshot();
    const origins = [state.server && new URL(state.server).origin, state.update?.url && new URL(state.update.url).origin].filter(Boolean);
    return ['https:', 'http:'].includes(target.protocol) && origins.includes(target.origin);
  } catch {
    return false;
  }
}

/** Todo método devolve { ok, data } ou { ok:false, error:{code,message} }: a janela nunca recebe uma exceção crua. */
function handle(channel, fn) {
  ipcMain.handle(`sg:${channel}`, async (_event, arg) => {
    try {
      return { ok: true, data: await fn(arg) };
    } catch (error) {
      if (!(error instanceof UserError)) console.error(`[${channel}]`, error);
      return { ok: false, error: { code: error.code ?? 'internal', message: error instanceof UserError ? error.message : 'Algo deu errado. Veja o registro.' } };
    }
  });
}

function registerIpc() {
  handle('snapshot', () => controller.snapshot());
  handle('buildEngine', (arg) => controller.buildEngine(arg));
  handle('pair', (arg) => controller.pair(arg));
  handle('unpair', () => controller.unpair());
  handle('startAgent', (arg) => controller.startAgent(arg));
  handle('stopAgent', () => controller.stopAgent());
  handle('createRoom', () => controller.createRoom());
  handle('youtubeLogin', () => controller.youtubeLogin());
  handle('youtubeStatus', () => controller.youtubeStatus());
  handle('importFile', (arg) => controller.importFile(arg));
  handle('hardware', () => controller.hardware());
  handle('settings', (arg) => controller.setSettings(arg));
  handle('checkUpdate', () => controller.checkUpdate());
  handle('loginItem', (enabled) => {
    if (typeof enabled === 'boolean') app.setLoginItemSettings({ openAtLogin: enabled });
    return app.getLoginItemSettings().openAtLogin;
  });
  handle('open', async (url) => {
    if (!allowedExternal(url)) throw new UserError('bad_url', 'Endereço não permitido.');
    await shell.openExternal(url);
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
}

function createWindow() {
  win = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 640,
    minHeight: 520,
    show: !process.env.SINGALONG_START_HIDDEN,
    title: 'Singalong Karaoke',
    backgroundColor: '#14141c',
    webPreferences: { preload: join(here, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.setMenuBarVisibility(false);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' })); // links nunca abrem janelas do Electron
  win.webContents.on('will-navigate', (event) => event.preventDefault());
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
  tray = new Tray(nativeImage.createFromPath(join(here, '..', 'ui', 'icon.png')));
  tray.setToolTip('Singalong Karaoke');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Abrir', click: () => { win.show(); win.focus(); } },
    { label: 'Sair', click: () => app.quit() },
  ]));
  tray.on('click', () => { win.show(); win.focus(); });
}

app.whenReady().then(async () => {
  registerIpc();
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
