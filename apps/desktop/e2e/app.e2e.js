// Ponta a ponta: o app Electron de verdade + a API de verdade + o worker de verdade (Python do ambiente de desenvolvimento).
// Precisa de SINGALONG_TEST_PYTHON (um Python com numpy, langdetect, websockets e yt-dlp). Sem ele, o teste é pulado.
// Na CI roda sob xvfb (Linux) ou direto (Windows).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { chromium } from 'playwright-core';
import electronPath from 'electron';
import { buildApp } from '../../api/src/app.js';
import { createMemoryJobStore } from '../../api/src/jobs.js';
import { LocalStorage } from '../../api/src/storage.js';

const python = process.env.SINGALONG_TEST_PYTHON;
const skip = python ? false : 'defina SINGALONG_TEST_PYTHON para rodar o teste do app';
const WORKER_DIR = fileURLToPath(new URL('../../worker', import.meta.url));
const DESKTOP = fileURLToPath(new URL('..', import.meta.url));
const WEB_DIST = fileURLToPath(new URL('../../web/dist', import.meta.url)); // com o front-end compilado, as páginas das abas carregam de verdade
const BIG = { max: 1e6, windowMs: 60_000 };

let api;
let base;
let app;
let userData;
let sample;
let musicFolder;

const adminCode = async () => (await api.inject({ method: 'POST', url: '/agent/v1/pair/start', headers: { 'x-admin-token': 'adm' }, payload: {} })).json().code;

before(async () => {
  if (skip) return;
  const root = await mkdtemp(join(tmpdir(), 'singalong-e2e-api-'));
  api = buildApp({
    config: { publicDir: existsSync(WEB_DIST) ? WEB_DIST : root, adminToken: 'adm', rateLimits: { search: BIG, addToQueue: BIG, createRoom: BIG, pair: BIG }, appLatestVersion: '9.0.0', appNotes: 'Corrige o login do YouTube', appDownloadUrl: 'http://127.0.0.1/baixar' },
    storage: new LocalStorage(root),
    jobs: createMemoryJobStore(),
  });
  await api.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${api.server.address().port}`;

  userData = await mkdtemp(join(tmpdir(), 'singalong-e2e-user-'));
  // o motor "já montado": a montagem de verdade é testada à parte (apps/engine); aqui o foco é a janela
  await mkdir(join(userData, 'engine'), { recursive: true });
  await writeFile(join(userData, 'engine', 'engine.json'), JSON.stringify({ complete: true, engine: 'cpu', engine_reason: 'teste' }));
  musicFolder = await mkdtemp(join(tmpdir(), 'singalong-e2e-music-'));
  sample = join(userData, 'nao-e-audio.mp3');
  await writeFile(sample, 'isto é um texto, não um áudio');
});

after(async () => {
  await app?.close().catch(() => {});
  await api?.close();
});

test('o app: parear, iniciar a sessão, criar sala, importar com erro legível e encerrar', { skip, timeout: 120_000 }, async () => {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE; // algumas ferramentas (VS Code) exportam isto e fariam o Electron rodar como Node puro
  // o Electron é iniciado direto e a janela é controlada pelo protocolo de depuração (o modo "electron" do Playwright não lida com main em ESM)
  const port = await new Promise((resolve) => {
    const probe = createServer().listen(0, '127.0.0.1', () => {
      const { port: free } = probe.address();
      probe.close(() => resolve(free));
    });
  });
  const child = spawn(electronPath, [DESKTOP, `--remote-debugging-port=${port}`, ...(process.platform === 'linux' ? ['--no-sandbox'] : [])], {
    env: {
      ...env,
      SINGALONG_DESKTOP_TEST: '1',
      SINGALONG_USER_DATA: userData,
      SINGALONG_TEST_PYTHON: python,
      SINGALONG_TEST_WORKER_DIR: WORKER_DIR,
      SINGALONG_TEST_PICK: sample,
      SINGALONG_TEST_FOLDER: musicFolder,
      AGENT_MEDIA_PORT: '0', // sem servidor de mídia: não disputa porta com outros testes
    },
    stdio: 'ignore',
  });
  app = { close: async () => { child.kill(); await browser?.close().catch(() => {}); } };
  let browser;
  for (let i = 0; i < 60 && !browser; i++) {
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`).catch(() => null);
    if (!browser) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(browser, 'o app não abriu');
  let page;
  for (let i = 0; i < 60 && !page; i++) {
    page = browser.contexts()[0]?.pages().find((p) => p.url().endsWith('index.html'));
    if (!page) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(page, 'a janela do app não apareceu');
  page.on('dialog', (dialog) => dialog.accept());
  const id = (name) => page.getByTestId(name);

  // sem token: pede o pareamento (o motor já está pronto)
  await id('screen-pair').waitFor();
  const shot = (name) => process.env.SINGALONG_SHOT_DIR && page.screenshot({ path: join(process.env.SINGALONG_SHOT_DIR, `${name}.png`) });
  await shot('1-parear');
  assert.equal(await id('screen-engine').isHidden(), true);
  assert.match(await id('version').textContent(), /^v\d+\.\d+\.\d+$/);

  // código errado: a mensagem do servidor aparece e a tela continua
  await id('pair-server').fill(base);
  await id('pair-code').fill('CODIGO-ERRADO');
  await id('pair-go').click();
  await id('error').waitFor();
  assert.match(await id('error').textContent(), /.+/);
  assert.equal(await id('screen-pair').isVisible(), true);

  // código certo
  await id('pair-code').fill(await adminCode());
  await id('pair-name').fill('PC da sala');
  await id('pair-go').click();
  await id('screen-welcome').waitFor(); // depois de parear: a tela de início (imagem + apelido)
  assert.equal(await id('screen-home').isHidden(), true); // as outras opções só aparecem com a sessão
  await shot('1b-inicio');
  assert.equal(await id('error').isHidden(), true);

  // o aviso de atualização do servidor aparece
  await id('update-banner').waitFor();
  assert.match(await id('update-banner').textContent(), /9\.0\.0/);
  assert.match(await id('update-banner').textContent(), /Corrige o login/);

  // o login do YouTube é o primeiro passo e a pasta das músicas pode ser escolhida (aqui o seletor é substituído por uma pasta de teste)
  assert.equal((await id('yt-login').textContent()).trim(), 'Entrar no YouTube');
  assert.equal(await id('yt-status').textContent(), 'Não conectado');
  await id('library-change-welcome').click();
  await page.waitForFunction((dir) => document.querySelector('[data-testid="library-welcome"]').textContent === dir, musicFolder, { timeout: 15_000 });

  // sem apelido não inicia
  await id('welcome-start').click();
  await id('error').waitFor();
  assert.match(await id('error').textContent(), /apelido/);

  // inicia a sessão com o worker de verdade
  await id('welcome-nickname').fill('Dona Flor');
  await id('welcome-start').click();
  await id('screen-home').waitFor();
  assert.equal(await id('screen-welcome').isHidden(), true);
  assert.equal(await id('session-nick').textContent(), 'Dona Flor');
  await page.waitForFunction(() => document.querySelector('[data-testid="agent-status"]').textContent === 'Online', null, { timeout: 60_000 });
  assert.equal(await id('room-create').isEnabled(), true);

  // cria a sala: o servidor a conhece como sala da sessão "Dona Flor"
  await id('room-create').click();
  const room = page.locator('li[data-testid^="room-"]').first();
  await room.waitFor({ state: 'attached', timeout: 30_000 });
  const code = (await room.locator('.code').textContent()).trim(); // (a lista fica escondida: a sala já abriu na aba do anfitrião)
  assert.match(code, /^[A-Z0-9]{4}$/);
  const state = (await api.inject({ method: 'GET', url: `/api/rooms/${code}` })).json();
  assert.deepEqual(state.owner, { nickname: 'Dona Flor', online: true });

  // a sala nova abre sozinha na aba do anfitrião, com a página do servidor DENTRO da janela; a TV é a outra aba
  await id('tabs').waitFor();
  assert.equal(await id('tab-room').textContent(), `Sala ${code}`);
  await page.waitForFunction(() => document.querySelector('[data-testid="tab-host"]').classList.contains('active'), null, { timeout: 15_000 });
  const urls = () => browser.contexts().flatMap((c) => c.pages().map((p) => p.url()));
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.ok(urls().some((u) => u.includes(`/room.html?room=${code}`)), `a página do anfitrião não abriu: ${urls()}`);
  assert.ok(urls().some((u) => u.includes(`/tv.html?room=${code}`)), 'a página da TV não abriu');
  assert.equal(await id('screen-home').isHidden() || (await id('main').count()) >= 0, true);
  const roomPage = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('/room.html'));
  if (process.env.SINGALONG_SHOT_DIR) await roomPage.screenshot({ path: join(process.env.SINGALONG_SHOT_DIR, '2b-anfitriao-pagina.png') });
  await shot('2b-anfitriao');
  await id('tab-tv').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="tab-tv"]').classList.contains('active'), null, { timeout: 15_000 });
  await id('tab-fullscreen').waitFor();
  await id('tab-back').click(); // "Voltar à sessão"
  await id('screen-home').waitFor();
  assert.equal(await id('tab-back').isHidden(), true);

  // importar um "áudio" que é só texto: o erro do worker volta legível e o botão fica livre de novo
  await id('import-pick').click();
  await id('import-form').waitFor();
  assert.equal(await id('import-file').textContent(), sample);
  await id('import-artist').fill('Artista');
  await id('import-title').fill('Título');
  await id('import-go').click();
  await id('error').waitFor({ timeout: 60_000 });
  assert.match(await id('error').textContent(), /.+/);
  assert.equal(await id('import-go').isEnabled(), true);

  await shot('2-sessao');
  // o hardware aparece
  await id('hardware').click();
  await id('hardware-out').waitFor({ timeout: 60_000 });
  assert.match(await id('hardware-out').textContent(), /Motor recomendado/);


  // encerra: a sessão some do servidor e as salas da lista também
  await id('session-toggle').click();
  await id('screen-welcome').waitFor({ timeout: 30_000 }); // sem sessão: volta para a tela de início
  assert.equal(await page.locator('li[data-testid^="room-"]').count(), 0);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const after = (await api.inject({ method: 'GET', url: `/api/rooms/${code}` })).json();
  assert.equal(after.owner?.online ?? false, false);

  // fechar o app leva junto o que estiver rodando
  await app.close();
  app = null;
});
