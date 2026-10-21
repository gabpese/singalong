// The app's controller: the settings, pairing, the engine, the agent (a real process), the Room, YouTube and importing.
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { APP_VERSION, BROWSER_NAMES, type ControllerOptions, createController, detectDefaultBrowser, normalizeServer, UserError, type Vault } from '../src/controller.ts';
import type { BrowserId, Snapshot } from '../ui/bridge.ts';

const FAKE = fileURLToPath(new URL('./fake-worker.ts', import.meta.url));

let server: Server;
let base: string;
const calls: { method: string | undefined; url: string; auth: string | null; body: Record<string, unknown> | null }[] = [];
let sessionOpen = false;
let roomFail = false;
let cloudOn = false;
let versionAnswer: Record<string, unknown> = { status: 'ok', current: APP_VERSION };

before(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '';
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      calls.push({ method: req.method, url, auth: req.headers.authorization ?? null, body: body ? JSON.parse(body) : null });
      const json = (status: number, data: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
      if (url === '/agent/v1/pair/complete') return body.includes('GOOD-CODE') ? json(201, { token: 'tok-1', device_id: 'd1' }) : json(400, { error: 'invalid_code', message: 'Código inválido ou expirado.' });
      if (url === '/agent/v1/pair/request') return body.includes('no-service') ? json(503, { error: 'email_disabled', message: 'Este servidor não envia códigos por e-mail.' }) : json(202, { ok: true, message: 'Se este e-mail estiver autorizado, o código chega em instantes.' });
      if (url.startsWith('/agent/v1/version')) return json(200, versionAnswer);
      if (req.headers.authorization !== 'Bearer tok-1') return json(401, { error: 'unauthorized', message: 'Dispositivo não autorizado.' });
      if (url === '/agent/v1/me') return json(200, { cloud: cloudOn, device: { id: 'd1', name: 'PC' }, session: sessionOpen ? { id: 's1', display_name: 'Gabriel' } : null });
      if (req.method === 'POST' && url === '/agent/v1/sessions/s1/rooms') return roomFail ? json(409, { error: 'session_ended', message: 'A sessão já terminou.' }) : json(201, { code: 'AB12', host_token: 'host-token', session_id: 's1' });
      if (req.method === 'DELETE' && url === '/agent/v1/sessions/s1') { sessionOpen = false; return res.writeHead(204).end(); }
      if (req.method === 'DELETE' && url === '/agent/v1/devices/me') return res.writeHead(204).end();
      if (url.startsWith('/agent/v1/stats')) return json(200, { days: Number(new URL(url, 'http://x').searchParams.get('days')), totals: { songs: 3, singers: 2, sessions: 1, cheers: 5, avg_score: 80, duets: 0, skipped: 1 }, top_songs: [], top_singers: [], most_cheered: [], by_day: [] });
      json(404, { error: 'not_found' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

interface MakeOptions {
  /** How the fake worker behaves (test/fake-worker.ts). */
  mode?: string;
  browser?: BrowserId;
  workerSource?: string;
  refreshWorkerImpl?: ControllerOptions['refreshWorkerImpl'];
  assembleImpl?: ControllerOptions['assembleImpl'];
  verifyImpl?: ControllerOptions['verifyImpl'];
  openVault?: ControllerOptions['openVault'];
}

async function make(options: MakeOptions = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'singalong-desk-'));
  const events: Snapshot[] = [];
  const controller = createController({
    dataDir,
    ...(options.workerSource ? { workerSource: options.workerSource } : {}),
    ...(options.refreshWorkerImpl ? { refreshWorkerImpl: options.refreshWorkerImpl } : {}),
    emit: (name, payload) => {
      if (name === 'state') events.push(payload as Snapshot);
    },
    launcher: (_root, args, extraEnv) => [process.execPath, [FAKE, ...args], { env: { ...process.env, ...extraEnv, FAKE_MODE: options.mode ?? '' } }],
    assembleImpl: options.assembleImpl ?? (async ({ onProgress }) => {
      onProgress?.({ step: 'component:python', label: 'Downloading python', done: 5, total: 10 });
      return { engine: 'cpu', engine_reason: 'no card' };
    }),
    verifyImpl: options.verifyImpl ?? (async () => ({ ok: true, checks: [] })),
    detectBrowser: async () => options.browser ?? 'edge',
    ...(options.openVault ? { openVault: options.openVault } : {}),
    pollMs: 40,
    restartMs: 20,
  });
  return { controller, dataDir, events };
}

async function ready(options?: MakeOptions) {
  const ctx = await make(options);
  await ctx.controller.init();
  await ctx.controller.buildEngine();
  await ctx.controller.pair({ server: base, code: 'GOOD-CODE', name: 'Living room PC' });
  return ctx;
}

/** A data folder with a ready engine, as an earlier run of the app leaves it. */
async function withEngine(dataDir: string) {
  await mkdir(join(dataDir, 'engine'), { recursive: true });
  await writeFile(join(dataDir, 'engine', 'engine.json'), JSON.stringify({ complete: true, engine: 'cpu' }));
}

const readConfig = async (dataDir: string) => JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf8'));

const until = async <T>(check: () => T | Promise<T>, ms = 4000): Promise<T> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for the condition');
};

test('normalizeServer: https always; http only on this computer or the local network; no user or password', () => {
  assert.equal(normalizeServer('https://singalong.example.org/'), 'https://singalong.example.org');
  assert.equal(normalizeServer('http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
  assert.equal(normalizeServer('http://192.168.0.10:3000/'), 'http://192.168.0.10:3000');
  for (const bad of ['http://example.org', 'ftp://x.org', 'junk', '', 'https://u:p@x.org']) assert.throws(() => normalizeServer(bad), UserError, bad);
});

test('the first time it opens: no engine, then after the engine it asks for pairing', async () => {
  const { controller } = await make();
  let snap = await controller.init();
  assert.equal(snap.phase, 'engine');
  assert.equal(snap.engine.status, 'missing');
  snap = await controller.buildEngine();
  assert.equal(snap.phase, 'pair');
  assert.equal(snap.engine.kind, 'cpu');
});

test('an engine already assembled (a complete engine.json) is recognized when the app opens', async () => {
  const { controller, dataDir } = await make();
  await mkdir(join(dataDir, 'engine'), { recursive: true });
  await writeFile(join(dataDir, 'engine', 'engine.json'), JSON.stringify({ complete: true, engine: 'cu121', engine_reason: 'RTX 3060' }));
  const snap = await controller.init();
  assert.equal(snap.engine.status, 'ready');
  assert.equal(snap.engine.kind, 'cu121');
});

test("when the app opens, an assembled engine gets the worker's new code (the app updated itself) and the log says so", async () => {
  const refreshed: unknown[] = [];
  const { controller, dataDir } = await make({ workerSource: '/resources/worker', refreshWorkerImpl: async (args) => { refreshed.push(args); return { updated: true, from: '0.4.0', to: '1.2.5' }; } });
  await withEngine(dataDir);
  const snap = await controller.init();
  assert.deepEqual(refreshed, [{ root: join(dataDir, 'engine'), workerSource: '/resources/worker' }]);
  assert.equal(snap.engine.status, 'ready');
  assert.ok(snap.logs.some((l) => l.line.includes('0.4.0') && l.line.includes('1.2.5')));
});

test("when the worker's code cannot be updated, the engine stays usable and the error goes to the log", async () => {
  const { controller, dataDir } = await make({ workerSource: '/resources/worker', refreshWorkerImpl: async () => { throw new Error('disk full'); } });
  await withEngine(dataDir);
  const snap = await controller.init();
  assert.equal(snap.engine.status, 'ready');
  assert.ok(snap.logs.some((l) => l.level === 'error' && l.line.includes('disk full')));
});

test('a failed engine assembly shows the error and allows another try; a failed check fails too', async () => {
  let attempt = 0;
  const { controller } = await make({ assembleImpl: async () => { if (++attempt === 1) throw new Error('no space left on device'); return { engine: 'cpu' }; } });
  await controller.init();
  const snap = await controller.buildEngine();
  assert.equal(snap.engine.status, 'error');
  assert.match(snap.engine.error ?? '', /no space left/);
  assert.equal((await controller.buildEngine()).engine.status, 'ready');

  const bad = await make({ verifyImpl: async () => ({ ok: false, checks: [{ name: 'ffmpeg', ok: false, detail: 'not found' }] }) });
  await bad.controller.init();
  assert.match((await bad.controller.buildEngine()).engine.error ?? '', /verificação falhou.*ffmpeg/);
});

test("the assembly's progress reaches the window", async () => {
  const { controller, events } = await make();
  await controller.init();
  await controller.buildEngine();
  assert.ok(events.some((s) => s.engine.status === 'building' && s.engine.progress?.label === 'Downloading python' && s.engine.progress.done === 5));
});

test("pairing keeps the token; a wrong code is refused with the server's message", async () => {
  const { controller, dataDir } = await make();
  await controller.init();
  await controller.buildEngine();
  await assert.rejects(controller.pair({ server: base, code: 'WRONG', name: 'PC' }), /Código inválido/);
  assert.equal(controller.snapshot().paired, false);
  await assert.rejects(controller.pair({ server: base, code: '12', name: 'PC' }), /Digite o código/);
  const snap = await controller.pair({ server: base, code: 'GOOD-CODE', name: 'Living room PC' });
  assert.equal(snap.paired, true);
  assert.equal(snap.phase, 'home');
  assert.equal((await readConfig(dataDir)).token, 'tok-1');
  assert.equal(JSON.stringify(controller.snapshot()).includes('tok-1'), false); // the token never goes to the window
});

test('the settings survive an app restart', async () => {
  const { controller, dataDir } = await ready();
  await controller.setSettings({ nickname: 'Gabriel' });
  const again = createController({ dataDir, assembleImpl: async () => ({ engine: 'cpu' }) });
  await withEngine(dataDir);
  const snap = await again.init();
  assert.equal(snap.paired, true);
  assert.equal(snap.nickname, 'Gabriel');
  assert.equal(snap.phase, 'home');
});

test('the update notice comes from the server', async () => {
  versionAnswer = { status: 'update_available', latest: '9.0.0', notes: 'Fixes the login', url: `${base}/download` };
  const { controller } = await ready();
  const update = await controller.checkUpdate();
  assert.equal(update?.status, 'update_available');
  assert.equal(controller.snapshot().update?.notes, 'Fixes the login');
  assert.ok(calls.some((c) => c.url === `/agent/v1/version?current=${APP_VERSION}`));
  versionAnswer = { status: 'ok' };
});

test('the agent: without a nickname it does not start; with one it starts the process and goes online once the Session exists on the server', async () => {
  const { controller } = await ready();
  await assert.rejects(controller.startAgent({ nickname: '  ' }), /apelido/);
  sessionOpen = false;
  await controller.startAgent({ nickname: 'Gabriel' });
  assert.equal(controller.snapshot().agent.status, 'starting');
  sessionOpen = true; // the real worker creates the Session on the server
  await until(() => controller.snapshot().agent.status === 'online');
  assert.equal(controller.snapshot().agent.session?.display_name, 'Gabriel');
  await until(() => controller.snapshot().logs.some((l) => l.line === 'worker consuming')); // the line may arrive a moment after 'online'
  await controller.stopAgent();
  assert.equal(controller.snapshot().agent.status, 'stopped');
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.url === '/agent/v1/sessions/s1')); // it ended the Session on the server
});

test('the agent gets the right environment (server, token, nickname, library), and the token is not an argument', async () => {
  const seen: { args: string[]; env: Record<string, string> }[] = [];
  const { dataDir } = await ready();
  const spy = createController({
    dataDir,
    launcher: (_root, args, env) => {
      seen.push({ args, env });
      return [process.execPath, [FAKE, ...args], { env: { ...process.env, ...env } }];
    },
    assembleImpl: async () => ({ engine: 'cpu' }),
    verifyImpl: async () => ({ ok: true, checks: [] }),
    pollMs: 1000,
  });
  await withEngine(dataDir);
  await spy.init();
  await spy.startAgent({ nickname: 'Dona Flor' });
  const { args, env } = seen[0];
  assert.deepEqual(args, ['--consume']);
  assert.equal(env.AGENT_URL, base);
  assert.equal(env.AGENT_TOKEN, 'tok-1');
  assert.equal(env.AGENT_SESSION_NAME, 'Dona Flor');
  assert.equal(env.STORAGE_ROOT, join(dataDir, 'library'));
  await spy.stopAgent();
});

test('an agent that falls is restarted; a refused token (exit code 2) is not, and asks for pairing again', async () => {
  const crash = await ready({ mode: 'crash' });
  await crash.controller.startAgent({ nickname: 'A' });
  // two worker processes start one after the other: a busy CI runner has taken more than the usual 4 s
  await until(() => crash.controller.snapshot().logs.filter((l) => l.line === 'worker consuming').length >= 2, 10_000);
  await crash.controller.stopAgent();

  const auth = await ready({ mode: 'auth' });
  await auth.controller.startAgent({ nickname: 'A' });
  await until(() => auth.controller.snapshot().agent.status === 'auth_error', 10_000);
  assert.match(auth.controller.snapshot().agent.error ?? '', /Pareie de novo/);
  const count = auth.controller.snapshot().logs.length;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(auth.controller.snapshot().logs.length, count); // it did not keep trying
});

test("creating a Room needs the Session online and answers the TV's and the Host's links", async () => {
  const { controller, events } = await ready();
  await assert.rejects(controller.createRoom(), /Inicie a sessão/);
  sessionOpen = true;
  await controller.startAgent({ nickname: 'Gabriel' });
  await until(() => controller.snapshot().agent.status === 'online');
  const room = await controller.createRoom();
  assert.ok(events.some((s) => s.busy === 'criando sala')); // the window shows "creating the Room…" while it waits
  assert.equal(controller.snapshot().busy, null);
  assert.equal(room.code, 'AB12');
  assert.equal(room.tv, `${base}/tv.html?room=AB12`);
  assert.equal(room.host, `${base}/room.html?room=AB12#host=host-token`);
  assert.equal(controller.snapshot().rooms.length, 1);
  await controller.stopAgent();
  assert.equal(controller.snapshot().rooms.length, 0); // the Session ended, the Rooms leave the list
  sessionOpen = false;
});

test('a Room that fails shows the reason and frees the window', async () => {
  const { controller } = await ready();
  roomFail = true;
  sessionOpen = true;
  await controller.startAgent({ nickname: 'G' });
  await until(() => controller.snapshot().agent.status === 'online');
  await assert.rejects(controller.createRoom(), /A sessão já terminou/);
  assert.equal(controller.snapshot().busy, null);
  roomFail = false;
  await controller.stopAgent();
  sessionOpen = false;
});

test('YouTube: checking and logging in update the state; a failed login comes back with its message', async () => {
  const { controller } = await ready();
  assert.equal((await controller.youtubeStatus()).status, 'connected');
  assert.equal((await controller.youtubeLogin()).status, 'connected');

  const out = await ready({ mode: 'yt-out' });
  assert.equal((await out.controller.youtubeStatus()).status, 'not-logged');

  const fail = await ready({ mode: 'yt-fail' });
  await assert.rejects(fail.controller.youtubeLogin(), /Tempo esgotado/);
  assert.equal(fail.controller.snapshot().youtube.status, 'not-logged');
  assert.equal(fail.controller.snapshot().busy, null); // free to try again
});

test("importing passes the file, artist and title to the worker; the worker's error comes back readable; two never run at once", async () => {
  const { controller } = await ready();
  const ok = await controller.importFile({ file: 'C:/songs/a.mp3', artist: 'Legião Urbana', title: 'Tempo Perdido' });
  assert.match(ok.message, /Legião Urbana - Tempo Perdido/);
  // @ts-expect-error the window always sends a file; without one the controller explains
  await assert.rejects(controller.importFile({}), /Escolha um arquivo/);

  const fail = await ready({ mode: 'import-fail' });
  await assert.rejects(fail.controller.importFile({ file: 'x.mp3' }), /não é um áudio válido/);
  assert.equal(fail.controller.snapshot().busy, null);

  const slow = await ready();
  const first = slow.controller.importFile({ file: 'a.mp3' });
  await assert.rejects(slow.controller.importFile({ file: 'b.mp3' }), /Aguarde/);
  await first;
});

test('the hardware is what the worker reports', async () => {
  const { controller } = await ready();
  assert.equal((await controller.hardware()).engine, 'cpu');
});

test('the actions that need pairing or the engine refuse before them', async () => {
  const { controller } = await make();
  await controller.init();
  await assert.rejects(controller.startAgent({ nickname: 'x' }), /Pareie|motor/);
  await assert.rejects(controller.importFile({ file: 'a.mp3' }), /Pareie|motor/);
});

test('unpairing stops the agent, revokes the device on the server and deletes the token', async () => {
  const { controller, dataDir } = await ready();
  sessionOpen = true;
  await controller.startAgent({ nickname: 'G' });
  await until(() => controller.snapshot().agent.status === 'online');
  const snap = await controller.unpair();
  assert.equal(snap.paired, false);
  assert.equal(snap.agent.status, 'stopped');
  assert.equal((await readConfig(dataDir)).token, undefined);
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.url === '/agent/v1/devices/me'));
  sessionOpen = false;
});

/**
 * A stand-in for the system vault: it "encrypts" by tagging and reversing the text with a key version, enough to show that the
 * plain token never reaches the disk and that a rotated key re-encrypts it.
 */
function fakeVault({ protects = true, failDecrypt = false, keyVersion = 'k1' } = {}): () => Promise<Vault> {
  return async () => ({
    available: true,
    protects,
    encrypt: async (text) => Buffer.from(`${keyVersion}:${[...text].reverse().join('')}`).toString('base64'),
    decrypt: async (sealed) => {
      if (failDecrypt) throw new Error('cannot decrypt here');
      const [version, reversed] = Buffer.from(sealed, 'base64').toString().split(':');
      return { text: [...reversed].reverse().join(''), reEncrypt: version !== keyVersion };
    },
  });
}

/** A data folder as an older or another run left it: config.json plus a ready engine. */
async function seed(config: Record<string, unknown>) {
  const dataDir = await mkdtemp(join(tmpdir(), 'singalong-desk-'));
  await writeFile(join(dataDir, 'config.json'), JSON.stringify(config));
  await withEngine(dataDir);
  return dataDir;
}

const sealedWith = async (keyVersion: string, token: string) => (await fakeVault({ keyVersion })()).encrypt(token);

test('the token reaches the disk only encrypted, and a restart decrypts it', async () => {
  const { controller, dataDir } = await ready({ openVault: fakeVault() });
  const file = await readFile(join(dataDir, 'config.json'), 'utf8');
  assert.equal(file.includes('tok-1'), false);
  assert.equal(JSON.parse(file).token, undefined);
  assert.ok(JSON.parse(file).token_enc);
  assert.equal(controller.snapshot().tokenProtected, true);

  const again = createController({ dataDir, openVault: fakeVault(), detectBrowser: async () => 'edge' });
  assert.equal((await again.init()).paired, true);
  const { server } = await again.stats({ days: 7 }); // the server answers only to `Bearer tok-1`
  assert.equal(server.days, 7);
});

test('a plain token left by an older version is encrypted on the first run', async () => {
  const dataDir = await seed({ server: base, token: 'tok-1', device_name: 'PC' });
  const controller = createController({ dataDir, openVault: fakeVault(), detectBrowser: async () => 'edge' });
  assert.equal((await controller.init()).paired, true);
  const saved = await readConfig(dataDir);
  assert.equal(saved.token, undefined);
  assert.equal(saved.token_enc, await sealedWith('k1', 'tok-1'));
});

test('a token encrypted under an older system key is stored again under the new one', async () => {
  const dataDir = await seed({ server: base, token_enc: await sealedWith('k1', 'tok-1'), device_name: 'PC' });
  const controller = createController({ dataDir, openVault: fakeVault({ keyVersion: 'k2' }), detectBrowser: async () => 'edge' });
  assert.equal((await controller.init()).paired, true);
  assert.equal((await readConfig(dataDir)).token_enc, await sealedWith('k2', 'tok-1'));
});

test('a token this computer cannot decrypt sends it back to pairing', async () => {
  const dataDir = await seed({ server: base, token_enc: await sealedWith('k1', 'tok-1'), device_name: 'PC' });
  const controller = createController({ dataDir, openVault: fakeVault({ failDecrypt: true }), detectBrowser: async () => 'edge' });
  const snap = await controller.init();
  assert.equal(snap.paired, false);
  assert.equal(snap.phase, 'pair');
  assert.equal((await readConfig(dataDir)).token_enc, undefined);
  assert.ok(snap.logs.some((entry) => entry.level === 'error' && /Pareie de novo/.test(entry.line)));
});

test('without a vault that protects it, the window is told the token is unprotected', async () => {
  const fixedKey = await ready({ openVault: fakeVault({ protects: false }) });
  assert.equal(fixedKey.controller.snapshot().tokenProtected, false);
  const none = await ready();
  assert.equal(none.controller.snapshot().tokenProtected, false);
  assert.equal((await readConfig(none.dataDir)).token, 'tok-1'); // no vault at all: plain text, as before
});

test("the logs are capped and the worker's text is never interpreted", async () => {
  const { controller } = await ready();
  for (let i = 0; i < 400; i++) controller.log(`<img src=x onerror=alert(1)> ${i}`);
  const logs = controller.snapshot().logs;
  assert.ok(logs.length <= 80);
  assert.ok(logs.at(-1)?.line.includes('<img')); // it arrives as plain text; the window uses textContent
});

type Exec = NonNullable<Parameters<typeof detectDefaultBrowser>[0]>;

test("Windows's default browser comes from the registry (Chrome, Edge, or another = automatic)", async () => {
  const answer = (progId: string, error: Error | null = null): Exec => (_command, _args, _options, callback) => callback(error, `
    ProgId    REG_SZ    ${progId}
`);
  assert.equal(await detectDefaultBrowser(answer('ChromeHTML'), 'win32'), 'chrome');
  assert.equal(await detectDefaultBrowser(answer('MSEdgeHTM'), 'win32'), 'edge');
  assert.equal(await detectDefaultBrowser(answer('FirefoxURL-308046B0AF4A39CB'), 'win32'), 'auto');
  assert.equal(await detectDefaultBrowser(answer('', new Error('no key')), 'win32'), 'auto');
});

test("Linux's default browser comes from xdg-settings; other systems and no answer stay automatic", async () => {
  const desktop = (name: string, error: Error | null = null): Exec => (command, args, _options, callback) => {
    assert.equal(command, 'xdg-settings');
    assert.deepEqual(args, ['get', 'default-web-browser']);
    callback(error, `${name}\n`);
  };
  assert.equal(await detectDefaultBrowser(desktop('google-chrome.desktop'), 'linux'), 'chrome');
  assert.equal(await detectDefaultBrowser(desktop('chromium_chromium.desktop'), 'linux'), 'chrome'); // Chromium (a snap) reads the cookies the same way
  assert.equal(await detectDefaultBrowser(desktop('microsoft-edge.desktop'), 'linux'), 'edge');
  assert.equal(await detectDefaultBrowser(desktop('firefox.desktop'), 'linux'), 'auto');
  assert.equal(await detectDefaultBrowser(desktop('', new Error('xdg-settings not found')), 'linux'), 'auto');
  assert.equal(await detectDefaultBrowser(() => assert.fail('must not ask anything'), 'freebsd'), 'auto'); // an unsupported system
});

test("macOS's default browser comes from LaunchServices' handlers (Chrome, Edge, or another = automatic)", async () => {
  const handlers = (bundle: string): Exec => (command, args, _options, callback) => {
    assert.equal(command, 'plutil');
    assert.deepEqual(args.slice(0, 4), ['-convert', 'json', '-o', '-']);
    callback(null, JSON.stringify({ LSHandlers: [{ LSHandlerURLScheme: 'mailto', LSHandlerRoleAll: 'com.apple.mail' }, ...(bundle ? [{ LSHandlerURLScheme: 'https', LSHandlerRoleAll: bundle }] : [])] }));
  };
  assert.equal(await detectDefaultBrowser(handlers('com.google.chrome'), 'darwin'), 'chrome');
  assert.equal(await detectDefaultBrowser(handlers('com.brave.browser'), 'darwin'), 'chrome');
  assert.equal(await detectDefaultBrowser(handlers('com.microsoft.edgemac'), 'darwin'), 'edge');
  assert.equal(await detectDefaultBrowser(handlers('com.apple.safari'), 'darwin'), 'auto');
  assert.equal(await detectDefaultBrowser(handlers(''), 'darwin'), 'auto'); // no choice made: Safari
  assert.equal(await detectDefaultBrowser((_command, _args, _options, callback) => callback(new Error('no file'), ''), 'darwin'), 'auto');
  assert.equal(await detectDefaultBrowser((_command, _args, _options, callback) => callback(null, 'not json'), 'darwin'), 'auto');
});

test('the YouTube login uses the default browser and lets no other be chosen', async () => {
  const edge = await ready({ browser: 'edge' });
  assert.equal(edge.controller.snapshot().browser, 'edge');
  assert.equal(edge.controller.snapshot().browserName, BROWSER_NAMES.edge);
  await edge.controller.youtubeLogin();
  assert.ok(edge.controller.snapshot().logs.some((l) => l.line.includes('Abrindo o navegador… edge')));
  // @ts-expect-error the browser is no longer a setting
  await edge.controller.setSettings({ browser: 'chrome' });
  assert.equal(edge.controller.snapshot().browser, 'edge');

  const other = await ready({ browser: 'auto' });
  await other.controller.youtubeLogin();
  assert.ok(other.controller.snapshot().logs.some((l) => l.line.includes('Abrindo o navegador… default'))); // no argument: the worker finds the browser
});

test('cancelling the YouTube login while it waits for the connection', async () => {
  const { controller } = await ready({ mode: 'yt-hang' });
  assert.equal(controller.cancelBusy(), false); // nothing under way
  const login = controller.youtubeLogin();
  await until(() => controller.snapshot().busy === 'login do YouTube');
  await until(() => controller.snapshot().logs.some((l) => l.line.startsWith('Abrindo o navegador')));
  assert.equal(controller.cancelBusy(), true);
  await assert.rejects(login, /cancelado/);
  assert.equal(controller.snapshot().busy, null); // it freed the window
  assert.notEqual(controller.snapshot().youtube.status, 'connected');
});

test("the songs' folder: checked, saved, kept across restarts, and unchanged while the Session runs", async () => {
  const { controller, dataDir } = await ready();
  const target = join(await mkdtemp(join(tmpdir(), 'singalong-lib-')), 'my songs');
  const snap = await controller.setLibraryDir(target);
  assert.equal(snap.libraryDir, target);
  assert.equal((await readConfig(dataDir)).library_dir, target);
  await assert.rejects(controller.setLibraryDir(''), /Escolha uma pasta/);
  await assert.rejects(controller.setLibraryDir(join(dataDir, 'config.json', 'inside-a-file')), /Não consigo gravar/);

  sessionOpen = true;
  const seen: string[] = [];
  const spy = createController({
    dataDir,
    launcher: (_root, args, env) => {
      seen.push(env.STORAGE_ROOT);
      return [process.execPath, [FAKE, ...args], { env: { ...process.env, ...env } }];
    },
    assembleImpl: async () => ({ engine: 'cpu' }),
    pollMs: 1000,
  });
  await withEngine(dataDir);
  await spy.init();
  await spy.startAgent({ nickname: 'G' });
  assert.equal(seen[0], target); // the agent saves the songs in the chosen folder
  await assert.rejects(spy.setLibraryDir(join(dataDir, 'other')), /Encerre a sessão/);
  await spy.stopAgent();
  sessionOpen = false;
});

test('switching the video card asks the engine to switch (only with the Session stopped) and shows the progress', async () => {
  const asked: { engine?: string; switchEngine?: boolean }[] = [];
  const { controller } = await ready({
    assembleImpl: async (options) => {
      asked.push(options);
      options.onProgress?.({ step: 'pip:0', label: 'Installing torch' });
      return { engine: options.engine === 'auto' ? 'cu121' : options.engine, engine_reason: 'test' };
    },
  });
  const snap = await controller.buildEngine({ engine: 'cpu', switchEngine: true });
  assert.equal(asked.at(-1)?.switchEngine, true);
  assert.equal(asked.at(-1)?.engine, 'cpu');
  assert.equal(snap.engine.kind, 'cpu');
  assert.equal(snap.engine.status, 'ready');

  sessionOpen = true;
  await controller.startAgent({ nickname: 'G' });
  await assert.rejects(controller.buildEngine({ engine: 'cu121', switchEngine: true }), /Encerre a sessão/);
  await controller.stopAgent();
  sessionOpen = false;
});

test('the chosen microphone is kept, cleared when going back to the default, and part of the state', async () => {
  const { controller, dataDir } = await ready();
  assert.equal(controller.snapshot().microphone, null);
  const snap = await controller.setSettings({ microphone: { id: 'abc123', label: 'USB microphone' } });
  assert.deepEqual(snap.microphone, { id: 'abc123', label: 'USB microphone' });
  assert.equal((await readConfig(dataDir)).microphone.id, 'abc123');
  assert.equal((await controller.setSettings({ microphone: { id: '', label: 'x' } })).microphone, null);
  assert.equal((await controller.setSettings({ microphone: null })).microphone, null);
});

test('asking for the code by e-mail: checks the address, uses the server given and shows the answer', async () => {
  const { controller } = await make();
  await controller.init();
  const before = calls.length;
  const answer = await controller.requestCode({ server: base, email: '  Dona@Example.com ' });
  assert.match(answer.message, /instantes/);
  const call = calls.slice(before).find((c) => c.url === '/agent/v1/pair/request');
  assert.deepEqual(call?.body, { email: 'Dona@Example.com' });
  assert.equal(call?.auth, null); // no token: not paired yet
  assert.equal(controller.snapshot().server, ''); // asking for the code neither pairs nor saves the server
  for (const bad of ['', 'junk', 'a@b']) await assert.rejects(controller.requestCode({ server: base, email: bad }), /e-mail válido/);
  await assert.rejects(controller.requestCode({ server: 'http://example.org', email: 'a@b.com' }), /https/);
  await assert.rejects(controller.requestCode({ server: base, email: 'no-service@example.com' }), /não envia códigos/);
  assert.equal(controller.snapshot().defaultServer, 'https://singalong.duckdns.org');
});

test("the app shows that this computer's songs go to the cloud when the server allows it", async () => {
  const { controller } = await ready();
  sessionOpen = true;
  cloudOn = true;
  await controller.startAgent({ nickname: 'G' });
  await until(() => controller.snapshot().agent.status === 'online');
  assert.equal(controller.snapshot().agent.cloud, true);
  await controller.stopAgent();
  cloudOn = false;
  sessionOpen = true; // the fake server closes the Session when it ends
  await controller.startAgent({ nickname: 'G' });
  await until(() => controller.snapshot().agent.status === 'online');
  assert.equal(controller.snapshot().agent.cloud, false);
  await controller.stopAgent();
  sessionOpen = false;
});

test('the update notice is checked again (at most once a day), not only when the app opens', async () => {
  let clock = 1_000_000;
  const dataDir = await mkdtemp(join(tmpdir(), 'singalong-desk-'));
  const controller = createController({
    dataDir,
    now: () => clock,
    detectBrowser: async () => 'edge',
    assembleImpl: async () => ({ engine: 'cpu' }),
    verifyImpl: async () => ({ ok: true, checks: [] }),
  });
  await controller.init();
  await controller.buildEngine();
  await controller.pair({ server: base, code: 'GOOD-CODE', name: 'PC' });
  versionAnswer = { status: 'ok' };
  await controller.checkUpdate();
  assert.equal(controller.snapshot().update?.status, 'ok');

  versionAnswer = { status: 'update_available', latest: '9.0.0', notes: 'News', url: `${base}/download` }; // the server announces it later
  clock += 23 * 60 * 60_000; // 23 hours later: still early, it does not ask again
  await controller.refreshUpdate();
  assert.equal(controller.snapshot().update?.status, 'ok');
  clock += 2 * 60 * 60_000; // past 24 hours: it asks and the notice shows
  await controller.refreshUpdate();
  assert.equal(controller.snapshot().update?.status, 'update_available');
  versionAnswer = { status: 'ok' };
});

test("the first Session's choice (the video card and the microphone) is remembered, and counts as done only when marked", async () => {
  const { controller, dataDir } = await ready();
  assert.equal(controller.snapshot().setupDone, false);
  assert.equal((await controller.setSettings({ setupDone: 'yes' })).setupDone, false); // only `true` counts
  const snap = await controller.setSettings({ microphone: { id: 'abc', label: 'USB' }, setupDone: true });
  assert.equal(snap.setupDone, true);
  assert.equal((await readConfig(dataDir)).setup_done, true);
  assert.equal((await controller.setSettings({ nickname: 'Ana' })).setupDone, true); // other changes do not undo it
});

test("statistics: what the server kept of the Rooms, joined with what is in this computer's library", async () => {
  const { controller, dataDir } = await make();
  await assert.rejects(() => controller.stats(), (error) => (error as UserError).code === 'not_paired');
  await controller.pair({ server: base, code: 'GOOD-CODE', name: 'PC' });

  // a library with two ready songs (meta.json) and a partial folder (no meta.json: it does not count)
  const cache = join(dataDir, 'library', 'cache');
  const songs: [string, number, Record<string, number>][] = [['aaaaaaaaaaa', 1000, { download: 10, separate: 50 }], ['bbbbbbbbbbb', 3000, { download: 20, separate: 100 }]];
  for (const [id, size, timings] of songs) {
    await mkdir(join(cache, id), { recursive: true });
    await writeFile(join(cache, id, 'instrumental.mp3'), Buffer.alloc(size));
    await writeFile(join(cache, id, 'meta.json'), JSON.stringify({ title: `Song ${id[0]}`, artist: 'Artist', timings_s: timings }));
  }
  await mkdir(join(cache, 'ccccccccccc'), { recursive: true });
  await writeFile(join(cache, 'ccccccccccc', 'instrumental.mp3'), Buffer.alloc(999));

  const result = await controller.stats({ days: 90 });
  assert.equal(result.server.days, 90);
  assert.equal(result.server.totals.songs, 3);
  assert.equal(calls.findLast((c) => c.url.startsWith('/agent/v1/stats'))?.auth, 'Bearer tok-1');
  assert.equal(result.library.songs, 2);
  assert.ok(result.library.bytes >= 4000 && result.library.bytes < 4400); // each one's mp3 and meta.json
  assert.equal(result.library.avg_prepare_s, 90); // (60 + 120) / 2
  assert.equal(result.library.biggest[0].title, 'Song b');

  assert.equal((await controller.stats({ days: 3 })).server.days, 30); // a period off the list goes back to the default
  const empty = await make();
  await empty.controller.pair({ server: base, code: 'GOOD-CODE', name: 'PC' });
  assert.deepEqual((await empty.controller.stats()).library, { songs: 0, bytes: 0, avg_prepare_s: null, biggest: [] }); // the library is still empty
});
