// The "brain" of the owner's app, without Electron (so it can be tested end to end with real processes): it keeps the settings,
// assembles the engine, pairs, starts and stops the agent (the worker as a service) and runs its commands (creating a Room, the
// YouTube login, importing a song, the hardware). The window only shows `snapshot()` and calls these methods.
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { assemble, refreshWorker } from '@singalong/engine/assemble';
import { paths, readState, workerCommand } from '@singalong/engine/engine';
import { verifyEngine } from '@singalong/engine/verify';
import type { AgentStatus, BrowserId, Microphone, OpenRoom, OwnerStats, ServerStats, Snapshot, UpdateInfo, YoutubeStatus } from '../ui/bridge.ts';
import { libraryStats } from './library-stats.ts';

export const APP_VERSION = '1.4.2'; // must match package.json and singalong_worker/version.py (a test checks)
const MAX_LOGS = 300;
const POLL_MS = 5000;

export class UserError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/** The server's address: https, or http only on this computer or the local network (development). */
export function normalizeServer(value: unknown): string {
  let url: URL;
  try {
    url = new URL(String(value ?? '').trim().replace(/\/+$/, ''));
  } catch {
    throw new UserError('bad_server', 'Endereço do servidor inválido.');
  }
  const local = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new UserError('bad_server', 'Use o endereço https:// do servidor.');
  if (url.username || url.password) throw new UserError('bad_server', 'O endereço não pode ter usuário ou senha.');
  return url.origin;
}

/** Linux's default browser .desktop file (xdg-settings) as the name the app knows. */
const browserFromDesktopFile = (name: string): BrowserId => (/chrom|brave|vivaldi/i.test(name) ? 'chrome' : /msedge|microsoft-edge/i.test(name) ? 'edge' : 'auto');

type ExecCallback = (error: Error | null, stdout: string | Buffer) => void;
type Exec = (command: string, args: string[], options: object, callback: ExecCallback) => unknown;

/**
 * The system's default browser (the https one): "chrome", "edge" or "auto" (another: the worker uses the Chrome or Edge it
 * finds). Windows: from the registry; Linux: from xdg-settings; macOS: from LaunchServices' handlers.
 */
export function detectDefaultBrowser(run: Exec = execFile as unknown as Exec, platform: string = process.platform): Promise<BrowserId> {
  return new Promise((resolve) => {
    if (platform === 'linux') {
      run('xdg-settings', ['get', 'default-web-browser'], { timeout: 5000 }, (error, stdout) => resolve(error ? 'auto' : browserFromDesktopFile(String(stdout).trim())));
      return;
    }
    if (platform === 'darwin') {
      // macOS keeps its default browser in LaunchServices' "handlers"; without an entry it is Safari (no use for the cookies: automatic)
      const plist = join(homedir(), 'Library', 'Preferences', 'com.apple.LaunchServices', 'com.apple.launchservices.secure.plist');
      run('plutil', ['-convert', 'json', '-o', '-', plist], { timeout: 5000 }, (error, stdout) => {
        let bundle = '';
        try {
          bundle = error ? '' : (JSON.parse(String(stdout)).LSHandlers ?? []).find((h: { LSHandlerURLScheme?: string }) => h.LSHandlerURLScheme === 'https')?.LSHandlerRoleAll ?? '';
        } catch {
          /* an unreadable file: automatic */
        }
        resolve(/edgemac/i.test(bundle) ? 'edge' : /chrome|brave|vivaldi/i.test(bundle) ? 'chrome' : 'auto');
      });
      return;
    }
    if (platform !== 'win32') return resolve('auto');
    run('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', '/v', 'ProgId'], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
      const progId = error ? '' : (/ProgId\s+REG_SZ\s+(\S+)/i.exec(String(stdout))?.[1] ?? '');
      resolve(/^ChromeHTML/i.test(progId) ? 'chrome' : /^MSEdgeHTM/i.test(progId) ? 'edge' : 'auto');
    });
  });
}

export const DEFAULT_SERVER = 'https://singalong.duckdns.org'; // the default server (the owner can change it on the connect screen)

export const BROWSER_NAMES: Record<BrowserId, string> = { chrome: 'Google Chrome', edge: 'Microsoft Edge', auto: 'o seu navegador' };

/**
 * Where the device token is kept: `available` (it can encrypt), `protects` (the key is the system's, not a fixed one),
 * `encrypt(text)` → base64, `decrypt(base64)` → `{ text, reEncrypt }`.
 */
export interface Vault {
  available: boolean;
  protects: boolean;
  encrypt(text: string): Promise<string>;
  decrypt(sealed: string): Promise<{ text: string; reEncrypt: boolean }>;
}

/**
 * Without a system vault (the tests, or a system that offers none) the device token stays in config.json as plain text, and
 * the window says it is not protected. The app passes Electron's `safeStorage` instead (see `systemVault` in main.ts).
 */
export const PLAIN_VAULT: Vault = {
  available: false,
  protects: false,
  encrypt: async () => {
    throw new Error('no vault');
  },
  decrypt: async () => {
    throw new Error('no vault');
  },
};

/** How the worker starts: [executable, arguments, options]. The tests swap in a fake worker. */
export type Launcher = (root: string, args: string[], extraEnv: Record<string, string>) => readonly [string, readonly string[], { cwd?: string; env?: NodeJS.ProcessEnv; windowsHide?: boolean }];

/** What config.json keeps (the token only encrypted, as `token_enc`, when there is a vault). */
interface Config {
  server: string;
  token: string;
  device_name: string;
  nickname: string;
  engine_dir: string;
  library_dir: string;
  microphone?: Microphone | null;
  setup_done?: boolean;
}

export interface ControllerOptions {
  dataDir: string;
  /** Where the worker's code that goes into the engine is (in the installed app: the resources folder). */
  workerSource?: string;
  version?: string;
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof spawn;
  assembleImpl?: typeof assemble;
  refreshWorkerImpl?: typeof refreshWorker;
  verifyImpl?: typeof verifyEngine;
  detectBrowser?: () => Promise<BrowserId>;
  /** Called by init(): Electron's vault only works once the app is ready. */
  openVault?: () => Promise<Vault>;
  now?: () => number;
  launcher?: Launcher;
  emit?: (event: string, payload: unknown) => void;
  pollMs?: number;
  restartMs?: number;
}

export type Controller = ReturnType<typeof createController>;

export function createController({
  dataDir,
  workerSource,
  version = APP_VERSION,
  fetchImpl = fetch,
  spawnImpl = spawn,
  assembleImpl = assemble,
  refreshWorkerImpl = refreshWorker,
  verifyImpl = verifyEngine,
  detectBrowser = detectDefaultBrowser,
  openVault = async () => PLAIN_VAULT,
  now = Date.now,
  launcher = (root, args, extraEnv) => workerCommand(root, args, extraEnv),
  emit = () => {},
  pollMs = POLL_MS,
  restartMs = 3000,
}: ControllerOptions) {
  const configFile = join(dataDir, 'config.json');
  let config: Config = { server: '', token: '', device_name: '', nickname: '', engine_dir: join(dataDir, 'engine'), library_dir: join(dataDir, 'library') };
  let vault = PLAIN_VAULT;
  let browser: BrowserId = 'auto'; // the computer's default browser (detected when the app opens)
  const state: Pick<Snapshot, 'engine' | 'agent' | 'rooms' | 'youtube' | 'update' | 'updateProgress' | 'busy' | 'logs'> = {
    engine: { status: 'unknown', progress: null, error: null, kind: null, reason: null },
    agent: { status: 'stopped', session: null, error: null },
    rooms: [],
    youtube: { status: 'unknown', detail: null },
    update: null,
    updateProgress: null,
    busy: null,
    logs: [],
  };
  let agentProcess: ChildProcess | null = null;
  let stopping = false;
  let pollTimer: NodeJS.Timeout | undefined;
  let restartTimer: NodeJS.Timeout | undefined;
  let restarts = 0;

  const publish = () => emit('state', snapshot());
  const log = (line: unknown, level: 'info' | 'error' = 'info') => {
    state.logs.push({ ts: Date.now(), level, line: String(line).slice(0, 500) });
    if (state.logs.length > MAX_LOGS) state.logs.splice(0, state.logs.length - MAX_LOGS);
    emit('log', state.logs.at(-1));
  };

  // Writes run one after another: encrypting the token waits on the system, and two writes must not share the temporary file.
  let writing: Promise<void> = Promise.resolve();
  function save(patch: Partial<Config>): Promise<void> {
    config = { ...config, ...patch };
    const run = writing.catch(() => {}).then(write);
    writing = run;
    return run;
  }

  /** The token reaches the disk only encrypted (`token_enc`); without a vault it stays as plain text. */
  async function write() {
    await mkdir(dataDir, { recursive: true });
    const { token, ...rest } = config;
    const stored = !token ? rest : vault.available ? { ...rest, token_enc: await vault.encrypt(token) } : { ...rest, token };
    const tmp = `${configFile}.tmp`;
    await writeFile(tmp, JSON.stringify(stored, null, 2));
    await rename(tmp, configFile);
  }

  /** Reads the encrypted token. When this computer cannot decrypt it (a copied profile, a replaced keychain), it pairs again. */
  async function openToken(sealed: string) {
    const opened = await vault.decrypt(sealed).catch(() => null);
    if (opened?.text) {
      config.token = opened.text;
      if (opened.reEncrypt) await save({}).catch(() => {}); // the system rotated its key: store the token under the new one
      return;
    }
    config.token = '';
    await save({}).catch(() => {});
    log('Não consegui ler o pareamento guardado neste computador. Pareie de novo; o aparelho antigo continua na lista do servidor, para ser revogado.', 'error');
  }

  function snapshot(): Snapshot {
    return {
      version,
      defaultServer: DEFAULT_SERVER,
      paired: Boolean(config.server && config.token),
      tokenProtected: !config.token || vault.protects, // false: the system has no vault and the window warns
      server: config.server,
      deviceName: config.device_name,
      nickname: config.nickname,
      microphone: config.microphone ?? null,
      setupDone: Boolean(config.setup_done), // the first Session's choice of video card and microphone is done?
      browser,
      browserName: BROWSER_NAMES[browser],
      engineDir: config.engine_dir,
      libraryDir: config.library_dir,
      phase: state.engine.status !== 'ready' ? 'engine' : !config.token ? 'pair' : 'home',
      ...structuredClone({ engine: state.engine, agent: state.agent, rooms: state.rooms, youtube: state.youtube, update: state.update, updateProgress: state.updateProgress, busy: state.busy }),
      logs: state.logs.slice(-80),
    };
  }

  // --- the server ---
  async function api<T = any>(method: string, path: string, { body, token = config.token, timeout = 15000, base = config.server }: { body?: unknown; token?: string; timeout?: number; base?: string } = {}): Promise<T> {
    let response: Response;
    try {
      response = await fetchImpl(`${base}/agent/v1${path}`, {
        method,
        // Fastify refuses a JSON content-type with an empty body
        headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      const failure = error as Error & { cause?: { code?: string } };
      throw new UserError('offline', `Não consegui falar com o servidor (${failure.cause?.code ?? failure.message}).`);
    }
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* an answer that is not JSON */
    }
    if (!response.ok) throw new UserError(data?.error ?? `http_${response.status}`, data?.message ?? `O servidor respondeu ${response.status}.`);
    return data;
  }

  // --- start-up ---
  async function init() {
    vault = await openVault().catch(() => PLAIN_VAULT);
    let stored: Partial<Config> & { token_enc?: string } = {};
    try {
      stored = JSON.parse(await readFile(configFile, 'utf8'));
    } catch {
      /* the first time the app opens */
    }
    const { token_enc: sealed, ...rest } = stored;
    config = { ...config, ...rest };
    if (sealed) await openToken(sealed);
    else if (config.token && vault.available) await save({}).catch(() => {}); // the first run after the update: encrypt the plain token (retried on the next run if the disk refuses)

    browser = await detectBrowser().catch((): BrowserId => 'auto');
    const engineState = await readState(config.engine_dir);
    if (engineState?.complete) {
      // the app updated itself: it brings the worker's code along (otherwise the computer would keep the old worker, and the server would refuse it)
      if (workerSource) {
        try {
          const refreshed = await refreshWorkerImpl({ root: config.engine_dir, workerSource });
          if (refreshed.updated) log(`Aplicativo do motor atualizado: ${refreshed.from ?? 'antigo'} → ${refreshed.to}.`);
        } catch (error) {
          log(`Não consegui atualizar o aplicativo do motor: ${(error as Error).message}`, 'error');
        }
      }
      state.engine = { status: 'ready', progress: null, error: null, kind: engineState.engine ?? null, reason: engineState.fallback_reason ?? engineState.engine_reason ?? null };
    } else {
      state.engine = { status: 'missing', progress: null, error: null, kind: null, reason: null };
    }
    publish();
    if (config.server) checkUpdate().catch(() => {});
    // the app may stay open in the tray for days: it checks for a new version once a day (and when the window comes back, if a day passed)
    setInterval(() => refreshUpdate().catch(() => {}), 60 * 60 * 1000).unref?.();
    return snapshot();
  }

  // --- the engine ---
  async function buildEngine({ engine = 'auto', switchEngine = false }: { engine?: string; switchEngine?: boolean } = {}) {
    if (state.engine.status === 'building') return snapshot();
    if (switchEngine && agentProcess) throw new UserError('session_running', 'Encerre a sessão para trocar a placa de vídeo.');
    state.engine = { ...state.engine, status: 'building', error: null, progress: { label: 'Preparando…' } };
    publish();
    try {
      const final = await assembleImpl({
        root: config.engine_dir,
        engine,
        ...(switchEngine ? { switchEngine: true } : {}),
        ...(workerSource ? { workerSource } : {}),
        onProgress: ({ label, done, total, line }) => {
          state.engine.progress = { label, done: done ?? null, total: total ?? null };
          if (line) log(line);
          publish();
        },
      });
      const report = await verifyImpl(config.engine_dir);
      if (!report.ok) throw new Error(`O motor foi montado, mas a verificação falhou: ${report.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('; ')}`);
      state.engine = { status: 'ready', progress: null, error: null, kind: final.engine ?? null, reason: final.fallback_reason ?? final.engine_reason ?? null };
      log(`Motor pronto (${final.engine}).`);
    } catch (error) {
      state.engine = { ...state.engine, status: 'error', progress: null, error: String((error as Error).message ?? error).slice(0, 600) };
      log(state.engine.error, 'error');
    }
    publish();
    return snapshot();
  }

  // --- pairing and the version ---
  async function pair({ server, code, name }: { server: string; code: string; name?: string }) {
    const url = normalizeServer(server);
    const cleanCode = String(code ?? '').trim();
    if (cleanCode.length < 4) throw new UserError('bad_code', 'Digite o código de pareamento.');
    const deviceName = String(name || 'Meu computador').trim().slice(0, 60);
    config.server = url; // api() uses the server in the settings
    try {
      const done = await api<{ token: string }>('POST', '/pair/complete', { body: { code: cleanCode, name: deviceName }, token: '' });
      await save({ server: url, token: done.token, device_name: deviceName });
    } catch (error) {
      config.server = '';
      throw error;
    }
    log(`Pareado com ${url}.`);
    checkUpdate().catch(() => {});
    publish();
    return snapshot();
  }

  /**
   * Asks again whether there is a new version, at most once a day (the window comes back from the background, the app stays
   * open in the tray for days: asking only when it opens would leave the notice out of date forever).
   */
  async function refreshUpdate() {
    if (now() - lastUpdateCheck < 24 * 60 * 60 * 1000) return state.update;
    return checkUpdate();
  }

  /** Asks the server to send the pairing code to the e-mail (it only arrives when the e-mail is authorized). */
  async function requestCode({ server, email }: { server?: string; email: string }) {
    const url = normalizeServer(server || DEFAULT_SERVER);
    const clean = String(email ?? '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(clean)) throw new UserError('bad_email', 'Digite um e-mail válido.');
    const answer = await api<{ message?: string } | null>('POST', '/pair/request', { body: { email: clean }, token: '', base: url });
    return { message: answer?.message ?? 'Pedido enviado.' };
  }

  async function unpair() {
    await stopAgent();
    try {
      await api('DELETE', '/devices/me');
    } catch {
      /* already revoked or no network: the local token goes anyway */
    }
    await save({ token: '' });
    state.rooms = [];
    publish();
    return snapshot();
  }

  let lastUpdateCheck = 0;
  async function checkUpdate(): Promise<UpdateInfo | null> {
    if (!config.server) return null;
    lastUpdateCheck = now();
    try {
      const response = await fetchImpl(`${config.server}/agent/v1/version?current=${encodeURIComponent(version)}`, { signal: AbortSignal.timeout(10000) });
      state.update = response.ok ? await response.json() : null;
    } catch {
      state.update = null;
    }
    publish();
    return state.update;
  }

  // --- the worker's commands (one short process per command) ---
  function workerEnv(extra: Record<string, string> = {}) {
    return {
      AGENT_URL: config.server,
      AGENT_TOKEN: config.token,
      AGENT_SESSION_NAME: config.nickname || config.device_name || 'Meu computador',
      STORAGE_ROOT: config.library_dir,
      LOG_FORMAT: 'text',
      ...extra,
    };
  }

  let busyChild: ChildProcess | null = null; // the long task's process under way (the login, an import): it can be cancelled
  let cancelled = false;

  function runWorker(args: string[], { env = {}, onLine = () => {}, timeoutMs = 0, cancellable = false }: { env?: Record<string, string>; onLine?: (line: string) => void; timeoutMs?: number; cancellable?: boolean } = {}): Promise<{ code: number | null; output: string }> {
    return new Promise((resolve, reject) => {
      const [exe, argv, options] = launcher(config.engine_dir, args, workerEnv(env));
      const child = spawnImpl(exe, [...argv], { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
      if (cancellable) busyChild = child;
      let output = '';
      const timer = timeoutMs ? setTimeout(() => child.kill(), timeoutMs) : null;
      const feed = (data: Buffer) => {
        const text = data.toString();
        output += text;
        for (const line of text.split(/\r?\n/)) if (line.trim()) onLine(line.trim());
      };
      child.stdout!.on('data', feed);
      child.stderr!.on('data', feed);
      child.on('error', (error) => reject(new UserError('spawn', `Não consegui iniciar o motor: ${error.message}`)));
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if (busyChild === child) busyChild = null;
        resolve({ code, output });
      });
    });
  }

  async function withBusy<T>(name: string, fn: () => Promise<T>): Promise<T> {
    if (state.busy) throw new UserError('busy', `Aguarde: ${state.busy}.`);
    state.busy = name;
    cancelled = false;
    publish();
    try {
      return await fn();
    } finally {
      state.busy = null;
      publish();
    }
  }

  async function createRoom(): Promise<OpenRoom> {
    requirePaired();
    const session = state.agent.session;
    if (state.agent.status !== 'online' || !session) throw new UserError('not_online', 'Inicie a sessão antes de criar uma sala.');
    return withBusy('criando sala', async () => {
      const room = await api<{ code: string; host_token: string }>('POST', `/sessions/${session.id}/rooms`, { body: {}, timeout: 20000 });
      const entry = { code: room.code, tv: `${config.server}/tv.html?room=${room.code}`, host: `${config.server}/room.html?room=${room.code}#host=${room.host_token}` };
      state.rooms = [entry, ...state.rooms.filter((r) => r.code !== entry.code)];
      log(`Sala ${entry.code} criada.`);
      return entry;
    });
  }

  async function youtubeStatus(): Promise<YoutubeStatus> {
    requirePaired();
    const { output } = await runWorker(['--youtube-status'], { timeoutMs: 60000 });
    const connected = /^Conectado/i.test(output.trim().split(/\r?\n/).pop() ?? '') || /Conectado ao YouTube/.test(output);
    state.youtube = { status: connected ? 'connected' : 'not-logged', detail: output.trim().split(/\r?\n/).pop() ?? '' };
    publish();
    return state.youtube;
  }

  async function youtubeLogin(): Promise<YoutubeStatus> {
    requirePaired();
    return withBusy('login do YouTube', async () => {
      const args = ['--youtube-login', ...(browser && browser !== 'auto' ? [browser] : [])];
      log('Abrindo o navegador para entrar no YouTube…');
      const { code, output } = await runWorker(args, { onLine: (line) => log(line), timeoutMs: 6 * 60 * 1000, cancellable: true });
      if (cancelled) throw new UserError('cancelled', 'Login cancelado.');
      state.youtube = { status: code === 0 ? 'connected' : 'not-logged', detail: output.trim().split(/\r?\n/).pop() ?? '' };
      if (code !== 0) throw new UserError('youtube_login', state.youtube.detail || 'O login do YouTube não foi concluído.');
      return state.youtube;
    });
  }

  async function importFile({ file, artist, title }: { file: string; artist?: string; title?: string }) {
    requirePaired();
    if (!file) throw new UserError('bad_file', 'Escolha um arquivo de áudio.');
    return withBusy('importando música', async () => {
      const args = ['--import', file, ...(artist ? ['--artist', artist] : []), ...(title ? ['--title', title] : [])];
      log(`Importando ${file}…`);
      const { code, output } = await runWorker(args, { onLine: (line) => log(line), timeoutMs: 30 * 60 * 1000, cancellable: true });
      if (cancelled) throw new UserError('cancelled', 'Importação cancelada.');
      const done = output.split(/\r?\n/).find((line) => line.startsWith('Pronto:'));
      if (code !== 0 || !done) {
        const reason = output.split(/\r?\n/).reverse().find((line) => line.startsWith('erro') || line.includes('Error')) ?? 'A importação falhou.';
        throw new UserError('import', reason.replace(/^erro:\s*/, ''));
      }
      return { message: done };
    });
  }

  /** Stops the login or the import under way ("Cancelar" on the waiting screen). */
  function cancelBusy() {
    if (!busyChild) return false;
    cancelled = true;
    busyChild.kill();
    return true;
  }

  async function hardware() {
    const { output } = await runWorker(['--hardware'], { timeoutMs: 60000 });
    try {
      return JSON.parse(output.slice(output.indexOf('{')));
    } catch {
      throw new UserError('hardware', 'Não consegui ler o hardware.');
    }
  }

  // --- the agent (the worker as a service) ---
  function requirePaired() {
    if (!(config.server && config.token)) throw new UserError('not_paired', 'Pareie este computador primeiro.');
    if (state.engine.status !== 'ready') throw new UserError('no_engine', 'O motor ainda não foi montado.');
  }

  async function startAgent({ nickname }: { nickname?: string } = {}) {
    requirePaired();
    const name = String(nickname ?? config.nickname ?? '').trim().slice(0, 40);
    if (!name) throw new UserError('bad_nickname', 'Escolha o apelido que os convidados vão ver.');
    if (agentProcess) return snapshot();
    await save({ nickname: name });
    stopping = false;
    restarts = 0;
    launchAgent();
    return snapshot();
  }

  function launchAgent() {
    state.agent = { status: 'starting', session: null, error: null };
    publish();
    const [exe, argv, options] = launcher(config.engine_dir, ['--consume'], workerEnv({ LOG_FORMAT: 'text' }));
    const child = spawnImpl(exe, [...argv], { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    agentProcess = child;
    const feed = (data: Buffer) => {
      for (const line of data.toString().split(/\r?\n/)) if (line.trim()) log(line.trim(), /\b(ERROR|CRITICAL)\b/.test(line) ? 'error' : 'info');
    };
    child.stdout!.on('data', feed);
    child.stderr!.on('data', feed);
    child.on('error', (error) => {
      state.agent = { status: 'offline', session: null, error: `Não consegui iniciar o agente: ${error.message}` };
      agentProcess = null;
      publish();
    });
    child.on('close', (code) => {
      if (agentProcess !== child) return;
      agentProcess = null;
      clearInterval(pollTimer);
      if (stopping) {
        state.agent = { status: 'stopped', session: null, error: null };
      } else if (code === 2) { // the token was refused (revoked): restarting does not help
        state.agent = { status: 'auth_error', session: null, error: 'O servidor recusou este computador (acesso revogado). Pareie de novo.' };
      } else {
        state.agent = { status: 'offline', session: null, error: `O agente parou (código ${code}). Tentando de novo…` };
        restarts += 1;
        restartTimer = setTimeout(() => !stopping && launchAgent(), Math.min(restartMs * restarts, 30000));
      }
      publish();
    });
    clearInterval(pollTimer);
    pollTimer = setInterval(pollSession, pollMs);
    setTimeout(pollSession, Math.min(1500, pollMs));
  }

  async function pollSession() {
    if (!agentProcess) return;
    try {
      const me = await api<{ session: AgentStatus['session']; cloud?: boolean }>('GET', '/me', { timeout: 8000 });
      const wasOnline = state.agent.status === 'online';
      state.agent = me.session ? { status: 'online', session: me.session, error: null, cloud: Boolean(me.cloud) } : { status: 'starting', session: null, error: null };
      if (!wasOnline && me.session) {
        restarts = 0;
        log(`Sessão "${me.session.display_name}" ativa.`);
      }
    } catch (error) {
      const failure = error as UserError;
      state.agent = { status: failure.code === 'unauthorized' ? 'auth_error' : 'offline', session: null, error: failure.message };
    }
    publish();
  }

  async function stopAgent() {
    stopping = true;
    clearInterval(pollTimer);
    clearTimeout(restartTimer);
    const child = agentProcess;
    if (!child) {
      state.agent = { status: 'stopped', session: null, error: null };
      publish();
      return snapshot();
    }
    // Windows has no "polite" SIGTERM. First note the Session, then kill the process (alive, its sign of life would open
    // another Session as soon as the server ended this one), and only then end the Session on the server: the pending
    // requests become "the owner left".
    let sessionId = state.agent.session?.id;
    if (!sessionId) {
      try {
        sessionId = (await api<{ session: { id: string } | null }>('GET', '/me', { timeout: 4000 })).session?.id;
      } catch {
        /* no network: the server ends the Session by itself for inactivity */
      }
    }
    await new Promise((resolve) => {
      child.once('close', resolve);
      child.kill();
      setTimeout(resolve, 5000);
    });
    if (sessionId) await api('DELETE', `/sessions/${sessionId}`, { timeout: 4000 }).catch((error: Error) => log(`Não consegui encerrar a sessão no servidor: ${error.message}`, 'error'));
    agentProcess = null;
    state.agent = { status: 'stopped', session: null, error: null };
    state.rooms = [];
    publish();
    return snapshot();
  }

  async function setSettings(patch: { nickname?: unknown; microphone?: { id?: unknown; label?: unknown } | null; setupDone?: unknown }) {
    const allowed: Partial<Config> = {};
    if (patch.nickname !== undefined) allowed.nickname = String(patch.nickname).trim().slice(0, 40);
    if (patch.microphone !== undefined) { // { id, label } chosen in the settings; null = the system's default
      const mic = patch.microphone;
      allowed.microphone = mic && typeof mic.id === 'string' && mic.id ? { id: mic.id.slice(0, 300), label: String(mic.label ?? '').slice(0, 120) } : null;
    }
    if (patch.setupDone === true) allowed.setup_done = true;
    await save(allowed);
    publish();
    return snapshot();
  }

  /** The owner's statistics: what played in the Rooms (the server) and what is in this computer's library. */
  async function stats({ days = 30 }: { days?: number } = {}): Promise<OwnerStats> {
    if (!(config.server && config.token)) throw new UserError('not_paired', 'Pareie este computador primeiro.');
    const period = [7, 30, 90, 365].includes(Number(days)) ? Number(days) : 30;
    const [server, library] = await Promise.all([api<ServerStats>('GET', `/stats?days=${period}`), libraryStats(config.library_dir)]);
    return { server, library };
  }

  const setUpdateProgress = (progress: Snapshot['updateProgress']) => {
    state.updateProgress = progress;
    publish();
  };

  /** The folder the downloaded songs go to. It changes only with the Session stopped (the agent is using the current one). */
  async function setLibraryDir(dir: unknown) {
    if (agentProcess) throw new UserError('session_running', 'Encerre a sessão para trocar a pasta das músicas.');
    const target = String(dir ?? '').trim();
    if (!target) throw new UserError('bad_folder', 'Escolha uma pasta.');
    const probe = join(target, `.singalong-teste-${process.pid}`);
    try {
      await mkdir(target, { recursive: true });
      await writeFile(probe, 'ok');
      await rm(probe, { force: true });
    } catch {
      throw new UserError('bad_folder', 'Não consigo gravar nessa pasta. Escolha outra.');
    }
    await save({ library_dir: target });
    log(`As músicas agora ficam em ${target}.`);
    publish();
    return snapshot();
  }

  return { init, snapshot, stats, refreshUpdate, requestCode, setLibraryDir, cancelBusy, setUpdateProgress, buildEngine, pair, unpair, checkUpdate, startAgent, stopAgent, createRoom, youtubeStatus, youtubeLogin, importFile, hardware, setSettings, log, paths: () => paths(config.engine_dir) };
}
