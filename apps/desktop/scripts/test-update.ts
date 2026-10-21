// A manual (clean machine) test of the automatic update, with the app really INSTALLED:
//   1) install the old version:              dist-old\singalong_karaoke.exe /S /D=D:\test-install
//   2) make the new version in another folder:   $env:SINGALONG_DIST="dist-new"; npm run dist
//   3) run:  node scripts/test-update.ts D:\test-install\singalong_karaoke.exe dist-new D:\test-data
// It starts a test server that announces the new version and serves the dist-new folder (installer + latest.yml), opens the app,
// clicks "Atualizar agora", waits for the installer to swap the version and checks that the user's data (the engine) is still there.
import { type ChildProcess, spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer as createHttp } from 'node:http';
import { type AddressInfo, createServer as createNet } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type Browser, chromium, type Page } from 'playwright-core';
// The API's compiled dist/ carries no types (ROADMAP, step 6), so these come in untyped.
// @ts-expect-error untyped
import { buildApp } from '../../api/dist/app.js';
// @ts-expect-error untyped
import { createMemoryJobStore } from '../../api/dist/jobs.js';
// @ts-expect-error untyped
import { LocalStorage } from '../../api/dist/storage.js';

const [exe, updateDir, userData] = process.argv.slice(2).map((p) => resolve(p));
if (!exe || !updateDir || !userData) {
  console.error('uso: node scripts/test-update.ts <instalado\\singalong_karaoke.exe> <pasta-com-a-versao-nova> <pasta-de-dados>');
  process.exit(2);
}
const log = (message: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
const newVersion = /version: (\S+)/.exec(await readFile(join(updateDir, 'latest.yml'), 'utf8'))?.[1];

// the updates' server (only the folder's files)
const files = createHttp(async (req, res) => {
  const name = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname.slice(1));
  const path = join(updateDir, name);
  if (!path.startsWith(updateDir) || !(await stat(path).catch(() => null))?.isFile()) return res.writeHead(404).end();
  res.writeHead(200, { 'content-length': (await stat(path)).size });
  createReadStream(path).pipe(res);
});
await new Promise<void>((resolveListen) => files.listen(0, '127.0.0.1', resolveListen));
const feed = `http://127.0.0.1:${(files.address() as AddressInfo).port}/`;

const BIG = { max: 1e6, windowMs: 60_000 };
const root = await mkdtemp(join(tmpdir(), 'sg-upd-api-'));
const api = await buildApp({
  config: { publicDir: root, adminToken: 'adm', rateLimits: { search: BIG, addToQueue: BIG, createRoom: BIG, pair: BIG }, appLatestVersion: newVersion, appMinVersion: '0.0.1', appNotes: 'Teste de atualização', appDownloadUrl: feed },
  storage: new LocalStorage(root),
  jobs: createMemoryJobStore(),
});
await api.listen({ port: 0, host: '127.0.0.1' });
const base = `http://127.0.0.1:${api.server.address().port}`;
await rm(join(userData, 'config.json'), { force: true }); // no old pairing: the test pairs with the test server

const freePort = () => new Promise<number>((resolveFree) => {
  const s = createNet().listen(0, '127.0.0.1', () => {
    const { port } = s.address() as AddressInfo;
    s.close(() => resolveFree(port));
  });
});

async function open(): Promise<{ child: ChildProcess; browser: Browser; page: Page }> {
  const port = await freePort();
  const env: NodeJS.ProcessEnv = { ...process.env, SINGALONG_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(exe, [`--remote-debugging-port=${port}`], { env, stdio: 'ignore' });
  let browser: Browser | null = null;
  for (let i = 0; i < 80 && !browser; i++) {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null);
    if (!browser) await new Promise((r) => setTimeout(r, 500));
  }
  let page: Page | undefined;
  for (let i = 0; i < 80 && !page; i++) {
    page = browser?.contexts()[0]?.pages().find((p) => p.url().endsWith('index.html'));
    if (!page) await new Promise((r) => setTimeout(r, 250));
  }
  if (!browser || !page) throw new Error('o app não abriu');
  return { child, browser, page };
}

let ok = false;
try {
  const first = await open();
  const id = (name: string) => first.page.getByTestId(name);
  const before = (await id('version').textContent())?.trim();
  log(`app instalado abriu, versão ${before}`);
  await id('screen-pair').waitFor({ timeout: 30000 });
  const code = (await api.inject({ method: 'POST', url: '/agent/v1/pair/start', headers: { 'x-admin-token': 'adm' }, payload: {} })).json().code;
  await first.page.locator('details.advanced summary').click();
  await id('pair-server').fill(base);
  await id('pair-code').fill(code);
  await id('pair-go').click();
  await id('update-banner').waitFor({ timeout: 30000 });
  log(`aviso: ${(await id('update-banner').textContent())?.replace(/\s+/g, ' ').trim()}`);
  const exited = new Promise((r) => first.child.once('exit', r));
  await first.page.locator('#update-open').click();
  log('clicou em "Atualizar agora": baixando, conferindo o hash e instalando…');
  await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('o app não fechou para instalar')), 180000))]);
  log('o app fechou para a instalação; esperando o instalador terminar');
  await new Promise((r) => setTimeout(r, 20000)); // the silent installer swaps the files and reopens the app by itself
  // The app the installer reopened (isForceRunAfter) is already running: close it so the check below opens one with debugging.
  // This is a clean test machine, where the installed app is the only one with that name.
  await new Promise((resolveKill) => spawn('taskkill', ['/IM', 'singalong_karaoke.exe', '/F'], { stdio: 'ignore' }).on('exit', resolveKill));
  await new Promise((r) => setTimeout(r, 3000));
  const second = await open();
  const after = (await second.page.getByTestId('version').textContent())?.trim();
  log(`depois da atualização: versão ${after}`);
  const engineKept = await second.page.getByTestId('screen-engine').isHidden();
  log(engineKept ? 'o motor e a configuração do usuário continuam lá (não pediu para preparar de novo)' : 'ATENÇÃO: pediu para preparar o motor de novo');
  second.child.kill();
  await second.browser.close().catch(() => {});
  ok = after === `v${newVersion}` && before !== after && engineKept;
  log(ok ? 'OK: atualizou de forma automática' : 'FALHOU');
} catch (error) {
  log(`FALHOU: ${String((error as Error).message).slice(0, 400)}`);
}
files.close();
await api.close();
process.exit(ok ? 0 : 1);
