// O "cérebro" do app do dono, sem Electron (por isso dá para testar de ponta a ponta com processos de verdade):
// guarda a configuração, monta o motor, pareia, inicia/para o agente (o worker em modo serviço) e roda os comandos dele
// (criar sala, login do YouTube, importar música, hardware). A janela só mostra o `snapshot()` e chama estes métodos.
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assemble } from '@singalong/engine/src/assemble.js';
import { paths, readState, workerCommand } from '@singalong/engine/src/engine.js';
import { verifyEngine } from '@singalong/engine/src/verify.js';

export const APP_VERSION = '0.5.0'; // tem de ser igual ao package.json e ao singalong_worker/version.py (um teste confere)
const MAX_LOGS = 300;
const POLL_MS = 5000;

export class UserError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

/** O endereço do servidor: https, ou http só no próprio computador / rede local (desenvolvimento). */
export function normalizeServer(value) {
  let url;
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

/** O navegador padrão do Windows (o do https): "chrome", "edge" ou "auto" (outro: o worker usa o Chrome/Edge que achar). */
export function detectDefaultBrowser(run = execFile) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve('auto');
    run('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice', '/v', 'ProgId'], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
      const progId = error ? '' : (/ProgId\s+REG_SZ\s+(\S+)/i.exec(String(stdout))?.[1] ?? '');
      resolve(/^ChromeHTML/i.test(progId) ? 'chrome' : /^MSEdgeHTM/i.test(progId) ? 'edge' : 'auto');
    });
  });
}

export const DEFAULT_SERVER = 'https://singalong.duckdns.org'; // o servidor padrão (o dono pode trocar na tela de conectar)

export const BROWSER_NAMES = { chrome: 'Google Chrome', edge: 'Microsoft Edge', auto: 'o seu navegador' };

export function createController({
  dataDir,
  workerSource, // onde está o código do worker que vai para dentro do motor (no app instalado: a pasta de recursos)
  version = APP_VERSION,
  fetchImpl = fetch,
  spawnImpl = spawn,
  assembleImpl = assemble,
  verifyImpl = verifyEngine,
  detectBrowser = detectDefaultBrowser,
  now = Date.now,
  launcher = (root, args, extraEnv) => workerCommand(root, args, extraEnv), // [exe, args, options]: os testes trocam por um worker de mentira
  emit = () => {},
  pollMs = POLL_MS,
  restartMs = 3000,
} = {}) {
  const configFile = join(dataDir, 'config.json');
  let config = { server: '', token: '', device_name: '', nickname: '', engine_dir: join(dataDir, 'engine'), library_dir: join(dataDir, 'library') };
  let browser = 'auto'; // o navegador padrão da máquina (detectado ao abrir)
  const state = {
    engine: { status: 'unknown', progress: null, error: null, kind: null, reason: null },
    agent: { status: 'stopped', session: null, error: null },
    rooms: [],
    youtube: { status: 'unknown', detail: null },
    update: null,
    updateProgress: null, // { percent } enquanto baixa a atualização
    busy: null, // nome da tarefa longa em andamento (importar, login...)
    logs: [],
  };
  let agentProcess = null;
  let stopping = false;
  let pollTimer = null;
  let restartTimer = null;
  let restarts = 0;

  const publish = () => emit('state', snapshot());
  const log = (line, level = 'info') => {
    state.logs.push({ ts: Date.now(), level, line: String(line).slice(0, 500) });
    if (state.logs.length > MAX_LOGS) state.logs.splice(0, state.logs.length - MAX_LOGS);
    emit('log', state.logs.at(-1));
  };

  async function save(patch) {
    config = { ...config, ...patch };
    await mkdir(dataDir, { recursive: true });
    const tmp = `${configFile}.tmp`;
    await writeFile(tmp, JSON.stringify(config, null, 2));
    await rename(tmp, configFile);
  }

  function snapshot() {
    return {
      version,
      defaultServer: DEFAULT_SERVER,
      paired: Boolean(config.server && config.token),
      server: config.server,
      deviceName: config.device_name,
      nickname: config.nickname,
      microphone: config.microphone ?? null,
      browser,
      browserName: BROWSER_NAMES[browser],
      engineDir: config.engine_dir,
      libraryDir: config.library_dir,
      phase: state.engine.status !== 'ready' ? 'engine' : !config.token ? 'pair' : 'home',
      ...structuredClone({ engine: state.engine, agent: state.agent, rooms: state.rooms, youtube: state.youtube, update: state.update, updateProgress: state.updateProgress, busy: state.busy }),
      logs: state.logs.slice(-80),
    };
  }

  // --- servidor ---
  async function api(method, path, { body, token = config.token, timeout = 15000, base = config.server } = {}) {
    let response;
    try {
      response = await fetchImpl(`${base}/agent/v1${path}`, {
        method,
        headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token ? { authorization: `Bearer ${token}` } : {}) }, // o Fastify recusa content-type JSON com corpo vazio
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      throw new UserError('offline', `Não consegui falar com o servidor (${error.cause?.code ?? error.message}).`);
    }
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      /* resposta que não é JSON */
    }
    if (!response.ok) throw new UserError(data?.error ?? `http_${response.status}`, data?.message ?? `O servidor respondeu ${response.status}.`);
    return data;
  }

  // --- inicialização ---
  async function init() {
    try {
      config = { ...config, ...JSON.parse(await readFile(configFile, 'utf8')) };
    } catch {
      /* primeira abertura */
    }
    browser = await detectBrowser().catch(() => 'auto');
    const engineState = await readState(config.engine_dir);
    if (engineState?.complete) {
      state.engine = { status: 'ready', progress: null, error: null, kind: engineState.engine, reason: engineState.fallback_reason ?? engineState.engine_reason };
    } else {
      state.engine = { status: 'missing', progress: null, error: null, kind: null, reason: null };
    }
    publish();
    if (config.server) checkUpdate().catch(() => {});
    // o app pode ficar dias aberto na bandeja: confere se saiu versão nova uma vez por dia (e quando a janela volta, se já passou um dia)
    setInterval(() => refreshUpdate().catch(() => {}), 60 * 60 * 1000).unref?.();
    return snapshot();
  }

  // --- motor ---
  async function buildEngine({ engine = 'auto', switchEngine = false } = {}) {
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
      state.engine = { status: 'ready', progress: null, error: null, kind: final.engine, reason: final.fallback_reason ?? final.engine_reason };
      log(`Motor pronto (${final.engine}).`);
    } catch (error) {
      state.engine = { ...state.engine, status: 'error', progress: null, error: String(error.message ?? error).slice(0, 600) };
      log(state.engine.error, 'error');
    }
    publish();
    return snapshot();
  }

  // --- pareamento e versão ---
  async function pair({ server, code, name }) {
    const url = normalizeServer(server);
    const cleanCode = String(code ?? '').trim();
    if (cleanCode.length < 4) throw new UserError('bad_code', 'Digite o código de pareamento.');
    const deviceName = String(name || 'Meu computador').trim().slice(0, 60);
    config.server = url; // o api() usa o servidor da configuração
    try {
      const done = await api('POST', '/pair/complete', { body: { code: cleanCode, name: deviceName }, token: '' });
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
   * Pergunta de novo se há versão nova, no máximo uma vez por dia (a janela volta do segundo plano, o app fica dias aberto na
   * bandeja: só perguntar ao abrir deixaria o aviso para sempre desatualizado).
   */
  async function refreshUpdate() {
    if (now() - lastUpdateCheck < 24 * 60 * 60 * 1000) return state.update;
    return checkUpdate();
  }

  /** Pede ao servidor que envie o código de pareamento para o e-mail (só chega se o e-mail estiver autorizado). */
  async function requestCode({ server, email }) {
    const url = normalizeServer(server || DEFAULT_SERVER);
    const clean = String(email ?? '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(clean)) throw new UserError('bad_email', 'Digite um e-mail válido.');
    const answer = await api('POST', '/pair/request', { body: { email: clean }, token: '', base: url });
    return { message: answer?.message ?? 'Pedido enviado.' };
  }

  async function unpair() {
    await stopAgent();
    try {
      await api('DELETE', '/devices/me');
    } catch {
      /* já revogado ou sem rede: o token local é descartado de qualquer forma */
    }
    await save({ token: '' });
    state.rooms = [];
    publish();
    return snapshot();
  }

  let lastUpdateCheck = 0;
  async function checkUpdate() {
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

  // --- comandos do worker (um processo curto por comando) ---
  function workerEnv(extra = {}) {
    return {
      AGENT_URL: config.server,
      AGENT_TOKEN: config.token,
      AGENT_SESSION_NAME: config.nickname || config.device_name || 'Meu computador',
      STORAGE_ROOT: config.library_dir,
      LOG_FORMAT: 'text',
      ...extra,
    };
  }

  let busyChild = null; // o processo da tarefa longa em andamento (login, importação): dá para cancelar
  let cancelled = false;

  function runWorker(args, { env = {}, onLine = () => {}, timeoutMs = 0, cancellable = false } = {}) {
    return new Promise((resolve, reject) => {
      const [exe, argv, options] = launcher(config.engine_dir, args, workerEnv(env));
      const child = spawnImpl(exe, argv, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
      if (cancellable) busyChild = child;
      let output = '';
      const timer = timeoutMs ? setTimeout(() => child.kill(), timeoutMs) : null;
      const feed = (data) => {
        const text = data.toString();
        output += text;
        for (const line of text.split(/\r?\n/)) if (line.trim()) onLine(line.trim());
      };
      child.stdout.on('data', feed);
      child.stderr.on('data', feed);
      child.on('error', (error) => reject(new UserError('spawn', `Não consegui iniciar o motor: ${error.message}`)));
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if (busyChild === child) busyChild = null;
        resolve({ code, output });
      });
    });
  }

  async function withBusy(name, fn) {
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

  async function createRoom() {
    requirePaired();
    const session = state.agent.session;
    if (state.agent.status !== 'online' || !session) throw new UserError('not_online', 'Inicie a sessão antes de criar uma sala.');
    return withBusy('criando sala', async () => {
      const room = await api('POST', `/sessions/${session.id}/rooms`, { body: {}, timeout: 20000 });
      const entry = { code: room.code, tv: `${config.server}/tv.html?room=${room.code}`, host: `${config.server}/room.html?room=${room.code}#host=${room.host_token}` };
      state.rooms = [entry, ...state.rooms.filter((r) => r.code !== entry.code)];
      log(`Sala ${entry.code} criada.`);
      return entry;
    });
  }

  async function youtubeStatus() {
    requirePaired();
    const { output } = await runWorker(['--youtube-status'], { timeoutMs: 60000 });
    const connected = /^Conectado/i.test(output.trim().split(/\r?\n/).pop() ?? '') || /Conectado ao YouTube/.test(output);
    state.youtube = { status: connected ? 'connected' : 'not-logged', detail: output.trim().split(/\r?\n/).pop() ?? '' };
    publish();
    return state.youtube;
  }

  async function youtubeLogin() {
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

  async function importFile({ file, artist, title }) {
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

  /** Interrompe o login ou a importação em andamento ("Cancelar" na tela de espera). */
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

  // --- o agente (worker em modo serviço) ---
  function requirePaired() {
    if (!(config.server && config.token)) throw new UserError('not_paired', 'Pareie este computador primeiro.');
    if (state.engine.status !== 'ready') throw new UserError('no_engine', 'O motor ainda não foi montado.');
  }

  async function startAgent({ nickname } = {}) {
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
    const child = spawnImpl(exe, argv, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    agentProcess = child;
    const feed = (data) => {
      for (const line of data.toString().split(/\r?\n/)) if (line.trim()) log(line.trim(), /\b(ERROR|CRITICAL)\b/.test(line) ? 'error' : 'info');
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
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
      } else if (code === 2) { // token recusado (revogado): reiniciar não adianta
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
      const me = await api('GET', '/me', { timeout: 8000 });
      const wasOnline = state.agent.status === 'online';
      state.agent = me.session ? { status: 'online', session: me.session, error: null, cloud: Boolean(me.cloud) } : { status: 'starting', session: null, error: null };
      if (!wasOnline && me.session) {
        restarts = 0;
        log(`Sessão "${me.session.display_name}" ativa.`);
      }
    } catch (error) {
      state.agent = { status: error.code === 'unauthorized' ? 'auth_error' : 'offline', session: null, error: error.message };
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
    // No Windows não existe SIGTERM "educado". Primeiro anota a sessão, depois mata o processo (se ele continuasse vivo, o
    // sinal de vida dele abriria outra sessão assim que o servidor encerrasse esta) e só então encerra a sessão pelo servidor:
    // os pedidos pendentes viram "o dono saiu".
    let sessionId = state.agent.session?.id;
    if (!sessionId) {
      try {
        sessionId = (await api('GET', '/me', { timeout: 4000 })).session?.id;
      } catch {
        /* sem rede: o servidor encerra a sessão sozinho por inatividade */
      }
    }
    await new Promise((resolve) => {
      child.once('close', resolve);
      child.kill();
      setTimeout(resolve, 5000);
    });
    if (sessionId) await api('DELETE', `/sessions/${sessionId}`, { timeout: 4000 }).catch((error) => log(`Não consegui encerrar a sessão no servidor: ${error.message}`, 'error'));
    agentProcess = null;
    state.agent = { status: 'stopped', session: null, error: null };
    state.rooms = [];
    publish();
    return snapshot();
  }

  async function setSettings(patch) {
    const allowed = {};
    if (patch.nickname !== undefined) allowed.nickname = String(patch.nickname).trim().slice(0, 40);
    if (patch.microphone !== undefined) { // { id, label } escolhido nas configurações; null = o padrão do sistema
      const mic = patch.microphone;
      allowed.microphone = mic && typeof mic.id === 'string' && mic.id ? { id: mic.id.slice(0, 300), label: String(mic.label ?? '').slice(0, 120) } : null;
    }
    await save(allowed);
    publish();
    return snapshot();
  }

  const setUpdateProgress = (progress) => { state.updateProgress = progress; publish(); };

  /** A pasta onde as músicas baixadas ficam. Só muda com a sessão parada (o agente está usando a pasta atual). */
  async function setLibraryDir(dir) {
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

  return { init, snapshot, refreshUpdate, requestCode, setLibraryDir, cancelBusy, setUpdateProgress, buildEngine, pair, unpair, checkUpdate, startAgent, stopAgent, createRoom, youtubeStatus, youtubeLogin, importFile, hardware, setSettings, log, paths: () => paths(config.engine_dir) };
}
