// End to end: the real Electron app + the real API + the real worker (the development environment's Python).
// It needs SINGALONG_TEST_PYTHON (a Python with numpy, langdetect, websockets and yt-dlp). Without it, the test is skipped.
// In CI it runs on Windows.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { type AddressInfo, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { spawn } from 'node:child_process';
import { type Browser, chromium, type Page } from 'playwright-core';
import electronPath from 'electron';
// The API's compiled dist/ carries no types (ROADMAP, step 6), so these come in untyped.
// @ts-expect-error untyped
import { buildApp } from '../../api/dist/app.js';
// @ts-expect-error untyped
import { createMemoryJobStore } from '../../api/dist/jobs.js';
// @ts-expect-error untyped
import { LocalStorage } from '../../api/dist/storage.js';

const python = process.env.SINGALONG_TEST_PYTHON;
const skip = python ? false : 'set SINGALONG_TEST_PYTHON to run the app test';
const WORKER_DIR = fileURLToPath(new URL('../../worker', import.meta.url));
const DESKTOP = fileURLToPath(new URL('..', import.meta.url));
const WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url)); // with the built pages, the tabs' pages really load
const BIG = { max: 1e6, windowMs: 60_000 };

/** What the test uses of the API's Fastify instance. */
interface Api {
  listen(options: { port: number; host: string }): Promise<unknown>;
  close(): Promise<void>;
  server: { address(): AddressInfo };
  inject(request: { method: string; url: string }): Promise<{ json(): { owner?: { nickname: string; online: boolean } } }>;
}

let api: Api | undefined;
let base: string;
let app: { close: () => Promise<void> } | null = null;
let userData: string;
let sample: string;
const mails: { to: string; text: string }[] = [];
let musicFolder: string;

before(async () => {
  if (skip) return;
  const root = await mkdtemp(join(tmpdir(), 'singalong-e2e-api-'));
  const server: Api = await buildApp({
    config: { publicDir: existsSync(WEB_DIST) ? WEB_DIST : root, adminToken: 'adm', pairAllowedEmails: ['dona@example.com'], rateLimits: { search: BIG, addToQueue: BIG, createRoom: BIG, pair: BIG, pairRequest: BIG, pairEmail: BIG }, appLatestVersion: '9.0.0', appNotes: 'Fixes the YouTube login', appDownloadUrl: 'http://127.0.0.1/download' },
    storage: new LocalStorage(root),
    jobs: createMemoryJobStore(),
    mailer: { enabled: true, send: async (message: { to: string; text: string }) => { mails.push(message); } }, // the "e-mail" lands in a list the test reads
  });
  await server.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${server.server.address().port}`;
  api = server;

  userData = await mkdtemp(join(tmpdir(), 'singalong-e2e-user-'));
  // the engine "already assembled": the real assembly is tested apart (apps/engine); here the focus is the window
  await mkdir(join(userData, 'engine'), { recursive: true });
  await writeFile(join(userData, 'engine', 'engine.json'), JSON.stringify({ complete: true, engine: 'cpu', engine_reason: 'test' }));
  musicFolder = await mkdtemp(join(tmpdir(), 'singalong-e2e-music-'));
  sample = join(userData, 'not-audio.mp3');
  await writeFile(sample, 'this is text, not audio');
});

after(async () => {
  await app?.close().catch(() => {});
  await api?.close();
});

test('the app: pair, start the Session, create a Room, import with a readable error and stop', { skip, timeout: 120_000 }, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // some tools (VS Code) export it, and Electron would run as plain Node
  // Electron starts directly and the window is driven over the debugging protocol (Playwright's "electron" mode cannot handle an ESM main)
  const port = await new Promise<number>((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port: free } = probe.address() as AddressInfo;
      probe.close(() => resolve(free));
    });
  });
  const electron = electronPath as unknown as string; // from Node, the electron package exports the binary's path
  const child = spawn(electron, [DESKTOP, `--remote-debugging-port=${port}`, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])], {
    env: {
      ...env,
      SINGALONG_DESKTOP_TEST: '1',
      SINGALONG_USER_DATA: userData,
      SINGALONG_TEST_PYTHON: python,
      SINGALONG_TEST_WORKER_DIR: WORKER_DIR,
      SINGALONG_TEST_PICK: sample,
      SINGALONG_TEST_FOLDER: musicFolder,
      AGENT_MEDIA_PORT: '0', // no media server: it does not fight other tests for a port
    },
    stdio: 'ignore',
  });
  let browser: Browser | null = null;
  app = { close: async () => { child.kill(); await browser?.close().catch(() => {}); } };
  for (let i = 0; i < 60 && !browser; i++) {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null);
    if (!browser) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(browser, 'the app did not open');
  const connected = browser;
  let found: Page | undefined;
  for (let i = 0; i < 60 && !found; i++) {
    found = connected.contexts()[0]?.pages().find((p) => p.url().endsWith('index.html'));
    if (!found) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(found, "the app's window did not show");
  const page = found;
  page.on('dialog', (dialog) => dialog.accept());
  const id = (name: string) => page.getByTestId(name);
  const text = async (name: string) => (await id(name).textContent()) ?? '';

  // no token: it asks for pairing (the engine is already ready)
  await id('screen-pair').waitFor();
  const shot = async (name: string) => {
    if (process.env.SINGALONG_SHOT_DIR) await page.screenshot({ path: join(process.env.SINGALONG_SHOT_DIR, `${name}.png`) });
  };
  await shot('1-pair');
  assert.equal(await id('screen-engine').isHidden(), true);
  assert.match(await text('version'), /^v\d+\.\d+\.\d+$/);

  // the default server comes filled in; here it points to the test server
  await page.locator('details.advanced summary').click();
  await id('pair-server').fill(base);

  // an e-mail that is not on the list: the same message and no code sent
  await id('pair-email').fill('intruder@example.com');
  await id('pair-send').click();
  await id('pair-sent').waitFor();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(mails.length, 0);

  // a wrong code: the server's message shows and the screen stays
  await id('pair-code').fill('WRONG-CODE');
  await id('pair-go').click();
  await id('error').waitFor();
  assert.match(await text('error'), /.+/);
  assert.equal(await id('screen-pair').isVisible(), true);

  // an authorized e-mail: the code arrives by e-mail and is used in the app
  await id('pair-email').fill('dona@example.com');
  await id('pair-send').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="pair-sent"]')?.textContent?.includes('instantes'), null, { timeout: 15_000 });
  for (let i = 0; i < 50 && mails.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'dona@example.com');
  const pairCode = /código[^:]*: ([A-Z0-9]{8})/.exec(mails[0].text)?.[1] ?? '';
  await id('pair-code').fill(pairCode);
  await id('pair-name').fill('Living room PC');
  await id('pair-go').click();
  await id('screen-welcome').waitFor(); // after pairing: the start screen (picture + nickname)
  assert.equal(await id('screen-home').isHidden(), true); // the other options show only with the Session
  await shot('1b-start');
  assert.equal(await id('error').isHidden(), true);

  // the device token reaches the disk only through the system vault (DPAPI on Windows, where CI runs this test)
  if (process.platform === 'win32') {
    const saved = JSON.parse(await readFile(join(userData, 'config.json'), 'utf8'));
    assert.equal(saved.token, undefined);
    assert.ok(saved.token_enc);
    assert.equal(await id('token-note').isHidden(), true);
  }

  // the server's update notice shows
  await id('update-banner').waitFor();
  assert.match(await text('update-banner'), /9\.0\.0/);
  assert.match(await text('update-banner'), /Fixes the YouTube login/);

  // the YouTube login is the first step
  assert.equal((await text('yt-login')).trim(), 'Entrar no YouTube');
  assert.equal(await text('yt-status'), 'Não conectado');

  // the settings (the gear): the YouTube account, the video card, the songs' folder and the microphone
  await id('gear').click();
  await id('screen-settings').waitFor();
  assert.equal(await id('screen-welcome').isHidden(), true);
  await page.waitForFunction(() => document.querySelector('[data-testid="gpu-info"]')?.textContent?.startsWith('Em uso:'), null, { timeout: 60_000 });
  assert.ok((await id('gpu-select').locator('option').count()) >= 2); // automatic and the processor (and the card, if there is one)
  await id('mic-select').waitFor();
  await id('library-change').click(); // here the folder picker is replaced by a test folder
  await page.waitForFunction((dir) => document.querySelector('[data-testid="library-home"]')?.textContent === dir, musicFolder, { timeout: 15_000 });
  await shot('1c-settings');
  await id('settings-back').click();
  await id('screen-welcome').waitFor();

  // without a nickname it does not start
  await id('welcome-start').click();
  await id('error').waitFor();
  assert.match(await text('error'), /apelido/);

  // starts the Session with the real worker
  await id('welcome-nickname').fill('Dona Flor');
  await id('welcome-start').click();
  // the first Session on this computer: before it starts, the dialog asks for the video card and the microphone
  await id('setup').waitFor();
  assert.ok((await id('setup-gpu').locator('option').count()) >= 2);
  await id('setup-mic').waitFor();
  await shot('1d-first-session');
  await id('setup-go').click();
  await id('screen-home').waitFor();
  assert.equal(await id('screen-welcome').isHidden(), true);
  assert.equal(await text('session-nick'), 'Dona Flor');
  await page.waitForFunction(() => document.querySelector('[data-testid="agent-status"]')?.textContent === 'Online', null, { timeout: 60_000 });
  assert.equal(await id('room-create').isEnabled(), true);

  // the owner's statistics: the card loads by itself (no song sung yet) and shows this computer's library
  await id('stats-body').waitFor({ state: 'attached' });
  await page.waitForFunction(() => document.querySelector('[data-testid="stats-body"]')?.textContent?.includes('músicas cantadas'), null, { timeout: 30_000 });
  assert.match(await text('stats-body'), /Biblioteca neste computador/);
  assert.equal(await id('stats-error').isHidden(), true);
  await id('stats-days').selectOption('7');
  await id('stats-refresh').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="stats-body"]')?.textContent?.includes('Biblioteca neste computador'), null, { timeout: 15_000 });

  // creates the Room: the server knows it as the "Dona Flor" Session's Room; the window shows it is creating it
  await id('room-create').click();
  await id('tab-rooms').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="tab-rooms"]')?.classList.contains('active'), null, { timeout: 30_000 });
  const code = ((await page.locator('[data-testid^="chip-"]').first().getAttribute('data-testid')) ?? '').slice('chip-'.length);
  assert.match(code, /^[A-Z0-9]{4}$/);
  const state = (await api!.inject({ method: 'GET', url: `/api/rooms/${code}` })).json();
  assert.deepEqual(state.owner, { nickname: 'Dona Flor', online: true });

  // entering a Room opens the TV (the server's page INSIDE the window); the Host is the other sub-tab
  await id('subtabs').waitFor();
  assert.equal(await text('rooms-count'), '1');
  await page.waitForFunction(() => document.querySelector('[data-testid="sub-tv"]')?.classList.contains('active'), null, { timeout: 15_000 });
  const pages = () => connected.contexts().flatMap((c) => c.pages());
  const urls = () => pages().map((p) => p.url());
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.ok(urls().some((u) => u.includes(`/room.html?room=${code}`)), `the Host's page did not open: ${urls()}`);
  assert.ok(urls().some((u) => u.includes(`/tv.html?room=${code}`)), "the TV's page did not open");
  assert.equal(await id('screen-home').isHidden(), true);
  await shot('2b-room-tv');
  await id('sub-host').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="sub-host"]')?.classList.contains('active'), null, { timeout: 15_000 });
  const roomPage = pages().find((p) => p.url().includes('/room.html'));
  if (process.env.SINGALONG_SHOT_DIR) await roomPage?.screenshot({ path: join(process.env.SINGALONG_SHOT_DIR, '2b-host-page.png') });
  await id('sub-tv').click();

  // back to the Session tab: create another Room, enter another Room, import songs
  await id('tab-session').click();
  await id('screen-home').waitFor();
  assert.equal(await id('subtabs').isHidden(), true);
  await id('room-create').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="rooms-count"]')?.textContent === '2', null, { timeout: 30_000 });
  assert.equal(await page.locator('[data-testid^="chip-"]').count(), 2);
  await id('tab-session').click();
  await id(`enter-${code}`).click(); // entering the first Room again: back to its TV
  await page.waitForFunction((c) => document.querySelector(`[data-testid="chip-${c}"]`)?.parentElement?.classList.contains('active'), code, { timeout: 15_000 });
  await id(`close-${code}`).click(); // closing the Room's tab (it still exists on the server)
  await page.waitForFunction(() => document.querySelector('[data-testid="rooms-count"]')?.textContent === '1', null, { timeout: 15_000 });
  await id('tab-session').click();
  await id('screen-home').waitFor();

  // importing an "audio" that is only text: the worker's error comes back readable and the button is free again
  await id('import-pick').click();
  await id('import-form').waitFor();
  assert.equal(await text('import-file'), sample);
  await id('import-artist').fill('Artist');
  await id('import-title').fill('Title');
  await id('import-go').click();
  await id('error').waitFor({ timeout: 60_000 });
  assert.match(await text('error'), /.+/);
  assert.equal(await id('import-go').isEnabled(), true);

  await shot('2-session');
  // stopping: the Session leaves the server and the Rooms leave the list too
  await id('session-toggle').click();
  await id('screen-welcome').waitFor({ timeout: 30_000 }); // no Session: back to the start screen
  await new Promise((resolve) => setTimeout(resolve, 300));
  const afterStop = (await api!.inject({ method: 'GET', url: `/api/rooms/${code}` })).json();
  assert.equal(afterStop.owner?.online ?? false, false);

  // closing the app takes along whatever is running
  await app.close();
  app = null;
});
