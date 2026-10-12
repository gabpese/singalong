// Teste manual/de máquina limpa da atualização automática, com o app INSTALADO de verdade:
//   1) instale a versão antiga:     dist-antiga\singalong_karaoke.exe /S /D=D:\teste-instalacao
//   2) gere a versão nova em outra pasta:   $env:SINGALONG_DIST="dist-nova"; npm run dist
//   3) rode:  node scripts/test-update.mjs D:\teste-instalacao\singalong_karaoke.exe dist-nova D:\dados-do-teste
// Sobe um servidor de teste que anuncia a versão nova e serve a pasta dist-nova (instalador + latest.yml), abre o app,
// clica em "Atualizar agora", espera o instalador trocar a versão e confere que os dados do usuário (o motor) continuam lá.
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createServer as createHttp } from 'node:http';
import { createServer as createNet } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildApp } from '../../api/src/app.js';
import { createMemoryJobStore } from '../../api/src/jobs.js';
import { LocalStorage } from '../../api/src/storage.js';
import { chromium } from 'playwright-core';

const [exe, updateDir, userData] = process.argv.slice(2).map((p) => resolve(p));
if (!exe || !updateDir || !userData) {
  console.error('uso: node scripts/test-update.mjs <instalado\\singalong_karaoke.exe> <pasta-com-a-versao-nova> <pasta-de-dados>');
  process.exit(2);
}
const log = (message) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${message}`);
const newVersion = /version: (\S+)/.exec(await readFile(join(updateDir, 'latest.yml'), 'utf8'))[1];

// servidor das atualizações (só arquivos da pasta)
const files = createHttp(async (req, res) => {
  const name = decodeURIComponent(new URL(req.url, 'http://x').pathname.slice(1));
  const path = join(updateDir, name);
  if (!path.startsWith(updateDir) || !(await stat(path).catch(() => null))?.isFile()) return res.writeHead(404).end();
  res.writeHead(200, { 'content-length': (await stat(path)).size });
  createReadStream(path).pipe(res);
});
await new Promise((resolveListen) => files.listen(0, '127.0.0.1', resolveListen));
const feed = `http://127.0.0.1:${files.address().port}/`;

const BIG = { max: 1e6, windowMs: 60_000 };
const root = await mkdtemp(join(tmpdir(), 'sg-upd-api-'));
const api = buildApp({
  config: { publicDir: root, adminToken: 'adm', rateLimits: { search: BIG, addToQueue: BIG, createRoom: BIG, pair: BIG }, appLatestVersion: newVersion, appMinVersion: '0.0.1', appNotes: 'Teste de atualização', appDownloadUrl: feed },
  storage: new LocalStorage(root),
  jobs: createMemoryJobStore(),
});
await api.listen({ port: 0, host: '127.0.0.1' });
const base = `http://127.0.0.1:${api.server.address().port}`;
await rm(join(userData, 'config.json'), { force: true }); // sem pareamento antigo: o teste pareia com o servidor de teste

const freePort = () => new Promise((resolveFree) => {
  const s = createNet().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolveFree(port)); });
});
async function open() {
  const port = await freePort();
  const env = { ...process.env, SINGALONG_USER_DATA: userData };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(exe, [`--remote-debugging-port=${port}`], { env, stdio: 'ignore' });
  let browser;
  for (let i = 0; i < 80 && !browser; i++) {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null);
    if (!browser) await new Promise((r) => setTimeout(r, 500));
  }
  let page;
  for (let i = 0; i < 80 && !page; i++) {
    page = browser?.contexts()[0]?.pages().find((p) => p.url().endsWith('index.html'));
    if (!page) await new Promise((r) => setTimeout(r, 250));
  }
  if (!page) throw new Error('o app não abriu');
  return { child, browser, page };
}

let ok = false;
try {
  const first = await open();
  const id = (name) => first.page.getByTestId(name);
  const before = (await id('version').textContent()).trim();
  log(`app instalado abriu, versão ${before}`);
  await id('screen-pair').waitFor({ timeout: 30000 });
  const code = (await api.inject({ method: 'POST', url: '/agent/v1/pair/start', headers: { 'x-admin-token': 'adm' }, payload: {} })).json().code;
  await first.page.locator('details.advanced summary').click();
  await id('pair-server').fill(base);
  await id('pair-code').fill(code);
  await id('pair-go').click();
  await id('update-banner').waitFor({ timeout: 30000 });
  log(`aviso: ${(await id('update-banner').textContent()).replace(/\s+/g, ' ').trim()}`);
  const exited = new Promise((r) => first.child.once('exit', r));
  await first.page.locator('#update-open').click();
  log('clicou em "Atualizar agora": baixando, conferindo o hash e instalando…');
  await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('o app não fechou para instalar')), 180000))]);
  log('o app fechou para a instalação; esperando o instalador terminar');
  await new Promise((r) => setTimeout(r, 20000)); // o instalador silencioso troca os arquivos e reabre o app sozinho
  // o app reaberto pelo instalador (isForceRunAfter) já está rodando: fecha-o para que a verificação abaixo abra um com depuração
  await new Promise((resolveKill) => spawn('taskkill', ['/IM', 'singalong_karaoke.exe', '/F'], { stdio: 'ignore' }).on('exit', resolveKill));
  await new Promise((r) => setTimeout(r, 3000));
  const second = await open();
  const after = (await second.page.getByTestId('version').textContent()).trim();
  log(`depois da atualização: versão ${after}`);
  const engineKept = await second.page.getByTestId('screen-engine').isHidden();
  log(engineKept ? 'o motor e a configuração do usuário continuam lá (não pediu para preparar de novo)' : 'ATENÇÃO: pediu para preparar o motor de novo');
  second.child.kill();
  await second.browser.close().catch(() => {});
  ok = after === `v${newVersion}` && before !== after && engineKept;
  log(ok ? 'OK: atualizou de forma automática' : 'FALHOU');
} catch (error) {
  log(`FALHOU: ${String(error.message).slice(0, 400)}`);
}
files.close();
await api.close();
process.exit(ok ? 0 : 1);
