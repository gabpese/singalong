// Ponta a ponta: o app Electron de verdade + a API de verdade + o worker de verdade (Python do ambiente de desenvolvimento).
// Precisa de SINGALONG_TEST_PYTHON (um Python com numpy, langdetect, websockets e yt-dlp). Sem ele, o teste é pulado.
// Na CI roda sob xvfb (Linux) ou direto (Windows).
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
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
const mails = [];
let musicFolder;


before(async () => {
  if (skip) return;
  const root = await mkdtemp(join(tmpdir(), 'singalong-e2e-api-'));
  api = buildApp({
    config: { publicDir: existsSync(WEB_DIST) ? WEB_DIST : root, adminToken: 'adm', pairAllowedEmails: ['dona@exemplo.com'], rateLimits: { search: BIG, addToQueue: BIG, createRoom: BIG, pair: BIG, pairRequest: BIG, pairEmail: BIG }, appLatestVersion: '9.0.0', appNotes: 'Corrige o login do YouTube', appDownloadUrl: 'http://127.0.0.1/baixar' },
    storage: new LocalStorage(root),
    jobs: createMemoryJobStore(),
    mailer: { enabled: true, send: async (message) => { mails.push(message); } }, // o "e-mail" cai numa lista, que o teste lê
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

  // o servidor padrão já vem preenchido; aqui ele aponta para o servidor de teste
  await page.locator('details.advanced summary').click();
  await id('pair-server').fill(base);

  // e-mail que não está na lista: a mesma mensagem e nenhum código enviado
  await id('pair-email').fill('intruso@exemplo.com');
  await id('pair-send').click();
  await id('pair-sent').waitFor();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(mails.length, 0);

  // código errado: a mensagem do servidor aparece e a tela continua
  await id('pair-code').fill('CODIGO-ERRADO');
  await id('pair-go').click();
  await id('error').waitFor();
  assert.match(await id('error').textContent(), /.+/);
  assert.equal(await id('screen-pair').isVisible(), true);

  // e-mail autorizado: o código chega por e-mail e é usado no app
  await id('pair-email').fill('dona@exemplo.com');
  await id('pair-send').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="pair-sent"]').textContent.includes('instantes'), null, { timeout: 15_000 });
  for (let i = 0; i < 50 && mails.length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(mails.length, 1);
  assert.equal(mails[0].to, 'dona@exemplo.com');
  const pairCode = /código[^:]*: ([A-Z0-9]{8})/.exec(mails[0].text)[1];
  await id('pair-code').fill(pairCode);
  await id('pair-name').fill('PC da sala');
  await id('pair-go').click();
  await id('screen-welcome').waitFor(); // depois de parear: a tela de início (imagem + apelido)
  assert.equal(await id('screen-home').isHidden(), true); // as outras opções só aparecem com a sessão
  await shot('1b-inicio');
  assert.equal(await id('error').isHidden(), true);

  // the device token reaches the disk only through the system vault (DPAPI on Windows, where CI runs this test)
  if (process.platform === 'win32') {
    const saved = JSON.parse(await readFile(join(userData, 'config.json'), 'utf8'));
    assert.equal(saved.token, undefined);
    assert.ok(saved.token_enc);
    assert.equal(await id('token-note').isHidden(), true);
  }

  // o aviso de atualização do servidor aparece
  await id('update-banner').waitFor();
  assert.match(await id('update-banner').textContent(), /9\.0\.0/);
  assert.match(await id('update-banner').textContent(), /Corrige o login/);

  // o login do YouTube é o primeiro passo e a pasta das músicas pode ser escolhida (aqui o seletor é substituído por uma pasta de teste)
  assert.equal((await id('yt-login').textContent()).trim(), 'Entrar no YouTube');
  assert.equal(await id('yt-status').textContent(), 'Não conectado');

  // configurações (a engrenagem): conta do YouTube, placa de vídeo, pasta das músicas e microfone
  await id('gear').click();
  await id('screen-settings').waitFor();
  assert.equal(await id('screen-welcome').isHidden(), true);
  await page.waitForFunction(() => document.querySelector('[data-testid="gpu-info"]').textContent.startsWith('Em uso:'), null, { timeout: 60_000 });
  assert.ok((await id('gpu-select').locator('option').count()) >= 2); // automático e processador (e a placa, se houver)
  await id('mic-select').waitFor();
  await id('library-change').click(); // aqui o seletor de pasta é substituído por uma pasta de teste
  await page.waitForFunction((dir) => document.querySelector('[data-testid="library-home"]').textContent === dir, musicFolder, { timeout: 15_000 });
  await shot('1c-configuracoes');
  await id('settings-back').click();
  await id('screen-welcome').waitFor();

  // sem apelido não inicia
  await id('welcome-start').click();
  await id('error').waitFor();
  assert.match(await id('error').textContent(), /apelido/);

  // inicia a sessão com o worker de verdade
  await id('welcome-nickname').fill('Dona Flor');
  await id('welcome-start').click();
  // primeira sessão neste computador: antes de começar, o modal pede a placa de vídeo e o microfone
  await id('setup').waitFor();
  assert.ok((await id('setup-gpu').locator('option').count()) >= 2);
  await id('setup-mic').waitFor();
  await shot('1d-primeira-sessao');
  await id('setup-go').click();
  await id('screen-home').waitFor();
  assert.equal(await id('screen-welcome').isHidden(), true);
  assert.equal(await id('session-nick').textContent(), 'Dona Flor');
  await page.waitForFunction(() => document.querySelector('[data-testid="agent-status"]').textContent === 'Online', null, { timeout: 60_000 });
  assert.equal(await id('room-create').isEnabled(), true);

  // estatísticas do dono: o cartão carrega sozinho (ainda sem músicas cantadas) e mostra a biblioteca deste computador
  await id('stats-body').waitFor({ state: 'attached' });
  await page.waitForFunction(() => document.querySelector('[data-testid="stats-body"]').textContent.includes('músicas cantadas'), null, { timeout: 30_000 });
  assert.match(await id('stats-body').textContent(), /Biblioteca neste computador/);
  assert.equal(await id('stats-error').isHidden(), true);
  await id('stats-days').selectOption('7');
  await id('stats-refresh').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="stats-body"]').textContent.includes('Biblioteca neste computador'), null, { timeout: 15_000 });

  // cria a sala: o servidor a conhece como sala da sessão "Dona Flor"; a tela mostra que está criando
  await id('room-create').click();
  await id('tab-rooms').waitFor();
  await page.waitForFunction(() => document.querySelector('[data-testid="tab-rooms"]').classList.contains('active'), null, { timeout: 30_000 });
  const code = (await page.locator('[data-testid^="chip-"]').first().getAttribute('data-testid')).slice('chip-'.length);
  assert.match(code, /^[A-Z0-9]{4}$/);
  const state = (await api.inject({ method: 'GET', url: `/api/rooms/${code}` })).json();
  assert.deepEqual(state.owner, { nickname: 'Dona Flor', online: true });

  // entrar numa sala abre o MODO TV (a página do servidor DENTRO da janela); o Anfitrião é a outra sub-aba
  await id('subtabs').waitFor();
  assert.equal(await id('rooms-count').textContent(), '1');
  await page.waitForFunction(() => document.querySelector('[data-testid="sub-tv"]').classList.contains('active'), null, { timeout: 15_000 });
  const urls = () => browser.contexts().flatMap((c) => c.pages().map((p) => p.url()));
  await new Promise((resolve) => setTimeout(resolve, 1000));
  assert.ok(urls().some((u) => u.includes(`/room.html?room=${code}`)), `a página do anfitrião não abriu: ${urls()}`);
  assert.ok(urls().some((u) => u.includes(`/tv.html?room=${code}`)), 'a página da TV não abriu');
  assert.equal(await id('screen-home').isHidden(), true);
  await shot('2b-sala-tv');
  await id('sub-host').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="sub-host"]').classList.contains('active'), null, { timeout: 15_000 });
  const roomPage = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('/room.html'));
  if (process.env.SINGALONG_SHOT_DIR) await roomPage.screenshot({ path: join(process.env.SINGALONG_SHOT_DIR, '2b-anfitriao-pagina.png') });
  await id('sub-tv').click();

  // de volta à aba Sessão: criar outra sala, entrar em outra sala, importar músicas
  await id('tab-session').click();
  await id('screen-home').waitFor();
  assert.equal(await id('subtabs').isHidden(), true);
  await id('room-create').click();
  await page.waitForFunction(() => document.querySelector('[data-testid="rooms-count"]').textContent === '2', null, { timeout: 30_000 });
  assert.equal(await page.locator('[data-testid^="chip-"]').count(), 2);
  await id('tab-session').click();
  await id(`enter-${code}`).click(); // entrar de novo na primeira sala: volta para o modo TV dela
  await page.waitForFunction((c) => document.querySelector(`[data-testid="chip-${c}"]`).parentElement.classList.contains('active'), code, { timeout: 15_000 });
  await id(`close-${code}`).click(); // fechar a aba da sala (ela continua existindo no servidor)
  await page.waitForFunction(() => document.querySelector('[data-testid="rooms-count"]').textContent === '1', null, { timeout: 15_000 });
  await id('tab-session').click();
  await id('screen-home').waitFor();

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
  // encerra: a sessão some do servidor e as salas da lista também
  await id('session-toggle').click();
  await id('screen-welcome').waitFor({ timeout: 30_000 }); // sem sessão: volta para a tela de início
  await new Promise((resolve) => setTimeout(resolve, 300));
  const after = (await api.inject({ method: 'GET', url: `/api/rooms/${code}` })).json();
  assert.equal(after.owner?.online ?? false, false);

  // fechar o app leva junto o que estiver rodando
  await app.close();
  app = null;
});
