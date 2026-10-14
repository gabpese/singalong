// Controlador do app: configuração, pareamento, motor, agente (processo de verdade), sala, YouTube e importação.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';
import { APP_VERSION, BROWSER_NAMES, createController, detectDefaultBrowser, normalizeServer, UserError } from '../src/controller.js';

const FAKE = fileURLToPath(new URL('./fake-worker.mjs', import.meta.url));

let server;
let base;
const calls = [];
let sessionOpen = false;
let roomFail = false;
let cloudOn = false;
let versionAnswer = { status: 'ok', current: APP_VERSION };

before(async () => {
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      calls.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? null, body: body ? JSON.parse(body) : null });
      const json = (status, data) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(data));
      if (req.url === '/agent/v1/pair/complete') return body.includes('BOM-CODIGO') ? json(201, { token: 'tok-1', device_id: 'd1' }) : json(400, { error: 'invalid_code', message: 'Código inválido ou expirado.' });
      if (req.url === '/agent/v1/pair/request') return body.includes('sem-servico') ? json(503, { error: 'email_disabled', message: 'Este servidor não envia códigos por e-mail.' }) : json(202, { ok: true, message: 'Se este e-mail estiver autorizado, o código chega em instantes.' });
      if (req.url.startsWith('/agent/v1/version')) return json(200, versionAnswer);
      if (req.headers.authorization !== 'Bearer tok-1') return json(401, { error: 'unauthorized', message: 'Dispositivo não autorizado.' });
      if (req.url === '/agent/v1/me') return json(200, { cloud: cloudOn, device: { id: 'd1', name: 'PC' }, session: sessionOpen ? { id: 's1', display_name: 'Gabriel' } : null });
      if (req.method === 'POST' && req.url === '/agent/v1/sessions/s1/rooms') return roomFail ? json(409, { error: 'session_ended', message: 'A sessão já terminou.' }) : json(201, { code: 'AB12', host_token: 'tok-anfitriao', session_id: 's1' });
      if (req.method === 'DELETE' && req.url === '/agent/v1/sessions/s1') { sessionOpen = false; return res.writeHead(204).end(); }
      if (req.method === 'DELETE' && req.url === '/agent/v1/devices/me') return res.writeHead(204).end();
      if (req.url.startsWith('/agent/v1/stats')) return json(200, { days: Number(new URL(req.url, 'http://x').searchParams.get('days')), totals: { songs: 3, singers: 2, sessions: 1, cheers: 5, avg_score: 80, duets: 0, skipped: 1 }, top_songs: [], top_singers: [], most_cheered: [], by_day: [] });
      json(404, { error: 'not_found' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function make(options = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'singalong-desk-'));
  const events = [];
  const controller = createController({
    dataDir,
    ...(options.workerSource ? { workerSource: options.workerSource } : {}),
    ...(options.refreshWorkerImpl ? { refreshWorkerImpl: options.refreshWorkerImpl } : {}),
    emit: (name, payload) => name === 'state' && events.push(payload),
    launcher: (root, args, extraEnv) => [process.execPath, [FAKE, ...args], { env: { ...process.env, ...extraEnv, FAKE_MODE: options.mode ?? '' } }],
    assembleImpl: options.assembleImpl ?? (async ({ onProgress }) => { onProgress({ label: 'Baixando python', done: 5, total: 10 }); return { engine: 'cpu', engine_reason: 'sem placa' }; }),
    verifyImpl: options.verifyImpl ?? (async () => ({ ok: true, checks: [] })),
    detectBrowser: async () => options.browser ?? 'edge',
    pollMs: 40,
    restartMs: 20,
  });
  return { controller, dataDir, events };
}

async function ready(options) {
  const ctx = await make(options);
  await ctx.controller.init();
  await ctx.controller.buildEngine();
  await ctx.controller.pair({ server: base, code: 'BOM-CODIGO', name: 'PC da sala' });
  return ctx;
}

const until = async (check, ms = 4000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('tempo esgotado esperando a condição');
};

test('normalizeServer: https sempre; http só no próprio computador ou rede local; sem usuário/senha', () => {
  assert.equal(normalizeServer('https://singalong.exemplo.org/'), 'https://singalong.exemplo.org');
  assert.equal(normalizeServer('http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
  assert.equal(normalizeServer('http://192.168.0.10:3000/'), 'http://192.168.0.10:3000');
  for (const bad of ['http://exemplo.org', 'ftp://x.org', 'lixo', '', 'https://u:p@x.org']) assert.throws(() => normalizeServer(bad), UserError, bad);
});

test('primeira abertura: sem motor, depois do motor pede o pareamento', async () => {
  const { controller } = await make();
  let snap = await controller.init();
  assert.equal(snap.phase, 'engine');
  assert.equal(snap.engine.status, 'missing');
  snap = await controller.buildEngine();
  assert.equal(snap.phase, 'pair');
  assert.equal(snap.engine.kind, 'cpu');
});

test('o motor já montado (engine.json completo) é reconhecido ao abrir', async () => {
  const { controller, dataDir } = await make();
  await mkdir(join(dataDir, 'engine'), { recursive: true });
  await writeFile(join(dataDir, 'engine', 'engine.json'), JSON.stringify({ complete: true, engine: 'cu121', engine_reason: 'RTX 3060' }));
  const snap = await controller.init();
  assert.equal(snap.engine.status, 'ready');
  assert.equal(snap.engine.kind, 'cu121');
});

test('ao abrir, o motor já montado recebe o código novo do worker (o app se atualizou) e isso fica no registro', async () => {
  const calls = [];
  const { controller, dataDir } = await make({ workerSource: '/recursos/worker', refreshWorkerImpl: async (args) => { calls.push(args); return { updated: true, from: '0.4.0', to: '1.2.5' }; } });
  await mkdir(join(dataDir, 'engine'), { recursive: true });
  await writeFile(join(dataDir, 'engine', 'engine.json'), JSON.stringify({ complete: true, engine: 'cpu' }));
  const snap = await controller.init();
  assert.deepEqual(calls, [{ root: join(dataDir, 'engine'), workerSource: '/recursos/worker' }]);
  assert.equal(snap.engine.status, 'ready');
  assert.ok(snap.logs.some((l) => l.line.includes('0.4.0') && l.line.includes('1.2.5')));
});

test('se não der para atualizar o código do worker, o motor continua utilizável e o erro vai para o registro', async () => {
  const { controller, dataDir } = await make({ workerSource: '/recursos/worker', refreshWorkerImpl: async () => { throw new Error('disco cheio'); } });
  await mkdir(join(dataDir, 'engine'), { recursive: true });
  await writeFile(join(dataDir, 'engine', 'engine.json'), JSON.stringify({ complete: true, engine: 'cpu' }));
  const snap = await controller.init();
  assert.equal(snap.engine.status, 'ready');
  assert.ok(snap.logs.some((l) => l.level === 'error' && l.line.includes('disco cheio')));
});

test('falha ao montar o motor: mostra o erro e permite tentar de novo; a verificação reprovada também falha', async () => {
  let attempt = 0;
  const { controller } = await make({ assembleImpl: async () => { if (++attempt === 1) throw new Error('sem espaço em disco'); return { engine: 'cpu' }; } });
  await controller.init();
  let snap = await controller.buildEngine();
  assert.equal(snap.engine.status, 'error');
  assert.match(snap.engine.error, /sem espaço/);
  assert.equal((await controller.buildEngine()).engine.status, 'ready');

  const bad = await make({ verifyImpl: async () => ({ ok: false, checks: [{ name: 'ffmpeg', ok: false, detail: 'não achei' }] }) });
  await bad.controller.init();
  assert.match((await bad.controller.buildEngine()).engine.error, /verificação falhou.*ffmpeg/);
});

test('o progresso da montagem chega à interface', async () => {
  const { controller, events } = await make();
  await controller.init();
  await controller.buildEngine();
  assert.ok(events.some((s) => s.engine.status === 'building' && s.engine.progress?.label === 'Baixando python' && s.engine.progress.done === 5));
});

test('pareamento: guarda o token, o código errado é recusado com a mensagem do servidor', async () => {
  const { controller, dataDir } = await make();
  await controller.init();
  await controller.buildEngine();
  await assert.rejects(controller.pair({ server: base, code: 'ERRADO', name: 'PC' }), /Código inválido/);
  assert.equal(controller.snapshot().paired, false);
  await assert.rejects(controller.pair({ server: base, code: '12', name: 'PC' }), /Digite o código/);
  const snap = await controller.pair({ server: base, code: 'BOM-CODIGO', name: 'PC da sala' });
  assert.equal(snap.paired, true);
  assert.equal(snap.phase, 'home');
  const saved = JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf8'));
  assert.equal(saved.token, 'tok-1');
  assert.equal(JSON.stringify(controller.snapshot()).includes('tok-1'), false); // o token nunca vai para a janela
});

test('a configuração sobrevive a reiniciar o app', async () => {
  const { controller, dataDir } = await ready();
  await controller.setSettings({ nickname: 'Gabriel' });
  const again = createController({ dataDir, assembleImpl: async () => ({ engine: 'cpu' }) });
  await mkdir(join(dataDir, 'engine'), { recursive: true });
  await writeFile(join(dataDir, 'engine', 'engine.json'), JSON.stringify({ complete: true, engine: 'cpu' }));
  const snap = await again.init();
  assert.equal(snap.paired, true);
  assert.equal(snap.nickname, 'Gabriel');
  assert.equal(snap.phase, 'home');
});

test('o aviso de atualização vem do servidor', async () => {
  versionAnswer = { status: 'update_available', latest: '9.0.0', notes: 'Corrige o login', url: `${base}/baixar` };
  const { controller } = await ready();
  const update = await controller.checkUpdate();
  assert.equal(update.status, 'update_available');
  assert.equal(controller.snapshot().update.notes, 'Corrige o login');
  assert.ok(calls.some((c) => c.url === `/agent/v1/version?current=${APP_VERSION}`));
  versionAnswer = { status: 'ok' };
});

test('agente: sem apelido não inicia; com apelido sobe o processo e fica online quando a sessão existe no servidor', async () => {
  const { controller } = await ready();
  await assert.rejects(controller.startAgent({ nickname: '  ' }), /apelido/);
  sessionOpen = false;
  await controller.startAgent({ nickname: 'Gabriel' });
  assert.equal(controller.snapshot().agent.status, 'starting');
  sessionOpen = true; // o worker de verdade cria a sessão no servidor
  await until(() => controller.snapshot().agent.status === 'online');
  assert.equal(controller.snapshot().agent.session.display_name, 'Gabriel');
  await until(() => controller.snapshot().logs.some((l) => l.line === 'worker consumindo')); // a linha pode chegar um instante depois do 'online'
  await controller.stopAgent();
  assert.equal(controller.snapshot().agent.status, 'stopped');
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.url === '/agent/v1/sessions/s1')); // encerrou a sessão no servidor
});

test('o agente recebe o ambiente certo (servidor, token, apelido, biblioteca) e o token não vai no argumento', async () => {
  const seen = [];
  const { controller, dataDir } = await ready();
  const spy = createController({
    dataDir,
    launcher: (root, args, env) => { seen.push({ args, env }); return [process.execPath, [FAKE, ...args], { env: { ...process.env, ...env } }]; },
    assembleImpl: async () => ({ engine: 'cpu' }),
    verifyImpl: async () => ({ ok: true, checks: [] }),
    pollMs: 1000,
  });
  await mkdir(join(dataDir, 'engine'), { recursive: true });
  await writeFile(join(dataDir, 'engine', 'engine.json'), JSON.stringify({ complete: true, engine: 'cpu' }));
  await spy.init();
  await spy.startAgent({ nickname: 'Dona Flor' });
  const { args, env } = seen[0];
  assert.deepEqual(args, ['--consume']);
  assert.equal(env.AGENT_URL, base);
  assert.equal(env.AGENT_TOKEN, 'tok-1');
  assert.equal(env.AGENT_SESSION_NAME, 'Dona Flor');
  assert.equal(env.STORAGE_ROOT, join(dataDir, 'library'));
  await spy.stopAgent();
  void controller;
});

test('agente que cai é reiniciado; token recusado (código 2) não reinicia e pede novo pareamento', async () => {
  const crash = await ready({ mode: 'crash' });
  await crash.controller.startAgent({ nickname: 'A' });
  await until(() => crash.controller.snapshot().logs.filter((l) => l.line === 'worker consumindo').length >= 2);
  await crash.controller.stopAgent();

  const auth = await ready({ mode: 'auth' });
  await auth.controller.startAgent({ nickname: 'A' });
  await until(() => auth.controller.snapshot().agent.status === 'auth_error');
  assert.match(auth.controller.snapshot().agent.error, /Pareie de novo/);
  const count = auth.controller.snapshot().logs.length;
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(auth.controller.snapshot().logs.length, count); // não ficou tentando
});

test('criar sala exige a sessão online e devolve os links da TV e do anfitrião', async () => {
  const { controller, events } = await ready();
  await assert.rejects(controller.createRoom(), /Inicie a sessão/);
  sessionOpen = true;
  await controller.startAgent({ nickname: 'Gabriel' });
  await until(() => controller.snapshot().agent.status === 'online');
  const room = await controller.createRoom();
  assert.ok(events.some((s) => s.busy === 'criando sala')); // a tela mostra "criando a sala…" enquanto espera
  assert.equal(controller.snapshot().busy, null);
  assert.equal(room.code, 'AB12');
  assert.equal(room.tv, `${base}/tv.html?room=AB12`);
  assert.equal(room.host, `${base}/room.html?room=AB12#host=tok-anfitriao`);
  assert.equal(controller.snapshot().rooms.length, 1);
  await controller.stopAgent();
  assert.equal(controller.snapshot().rooms.length, 0); // sessão encerrada, salas somem da lista
  sessionOpen = false;
});

test('sala que falha mostra o motivo e libera a tela', async () => {
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

test('YouTube: conferir e entrar atualizam o estado; falha do login volta com a mensagem', async () => {
  const { controller } = await ready();
  assert.equal((await controller.youtubeStatus()).status, 'connected');
  assert.equal((await controller.youtubeLogin()).status, 'connected');

  const out = await ready({ mode: 'yt-out' });
  assert.equal((await out.controller.youtubeStatus()).status, 'not-logged');

  const fail = await ready({ mode: 'yt-fail' });
  await assert.rejects(fail.controller.youtubeLogin(), /Tempo esgotado/);
  assert.equal(fail.controller.snapshot().youtube.status, 'not-logged');
  assert.equal(fail.controller.snapshot().busy, null); // liberou para tentar de novo
});

test('importar: passa arquivo, artista e título ao worker; erro do worker volta legível; não roda duas ao mesmo tempo', async () => {
  const { controller } = await ready();
  const ok = await controller.importFile({ file: 'C:/musicas/a.mp3', artist: 'Legião Urbana', title: 'Tempo Perdido' });
  assert.match(ok.message, /Legião Urbana - Tempo Perdido/);
  await assert.rejects(controller.importFile({}), /Escolha um arquivo/);

  const fail = await ready({ mode: 'import-fail' });
  await assert.rejects(fail.controller.importFile({ file: 'x.mp3' }), /não é um áudio válido/);
  assert.equal(fail.controller.snapshot().busy, null);

  const slow = await ready();
  const first = slow.controller.importFile({ file: 'a.mp3' });
  await assert.rejects(slow.controller.importFile({ file: 'b.mp3' }), /Aguarde/);
  await first;
});

test('hardware devolve o que o worker informa', async () => {
  const { controller } = await ready();
  assert.equal((await controller.hardware()).engine, 'cpu');
});

test('ações que precisam de pareamento ou motor recusam antes disso', async () => {
  const { controller } = await make();
  await controller.init();
  await assert.rejects(controller.startAgent({ nickname: 'x' }), /Pareie|motor/);
  await assert.rejects(controller.importFile({ file: 'a.mp3' }), /Pareie|motor/);
});

test('desparear para o agente, revoga no servidor e apaga o token', async () => {
  const { controller, dataDir } = await ready();
  sessionOpen = true;
  await controller.startAgent({ nickname: 'G' });
  await until(() => controller.snapshot().agent.status === 'online');
  const snap = await controller.unpair();
  assert.equal(snap.paired, false);
  assert.equal(snap.agent.status, 'stopped');
  assert.equal(JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf8')).token, '');
  assert.ok(calls.some((c) => c.method === 'DELETE' && c.url === '/agent/v1/devices/me'));
  sessionOpen = false;
});

test('os registros são limitados e o texto do worker nunca é interpretado', async () => {
  const { controller } = await ready();
  for (let i = 0; i < 400; i++) controller.log(`<img src=x onerror=alert(1)> ${i}`);
  const logs = controller.snapshot().logs;
  assert.ok(logs.length <= 80);
  assert.ok(logs.at(-1).line.includes('<img')); // chega como texto puro; a janela usa textContent
});

test('o navegador padrão do Windows vem do registro (Chrome, Edge ou outro = automático)', async () => {
  const answer = (progId, error = null) => (command, args, options, callback) => callback(error, `
    ProgId    REG_SZ    ${progId}
`);
  if (process.platform !== 'win32') return; // o registro só existe no Windows: nos outros sistemas a resposta é sempre "auto"
  assert.equal(await detectDefaultBrowser(answer('ChromeHTML')), 'chrome');
  assert.equal(await detectDefaultBrowser(answer('MSEdgeHTM')), 'edge');
  assert.equal(await detectDefaultBrowser(answer('FirefoxURL-308046B0AF4A39CB')), 'auto');
  assert.equal(await detectDefaultBrowser(answer('', new Error('sem chave'))), 'auto');
});

test('o login do YouTube usa o navegador padrão e não deixa escolher outro', async () => {
  const edge = await ready({ browser: 'edge' });
  assert.equal(edge.controller.snapshot().browser, 'edge');
  assert.equal(edge.controller.snapshot().browserName, BROWSER_NAMES.edge);
  await edge.controller.youtubeLogin();
  assert.ok(edge.controller.snapshot().logs.some((l) => l.line.includes('Abrindo o navegador… edge')));
  await edge.controller.setSettings({ browser: 'chrome' }); // a escolha do usuário não existe mais
  assert.equal(edge.controller.snapshot().browser, 'edge');

  const other = await ready({ browser: 'auto' });
  await other.controller.youtubeLogin();
  assert.ok(other.controller.snapshot().logs.some((l) => l.line.includes('Abrindo o navegador… padrao'))); // sem argumento: o worker acha o navegador
});

test('cancelar o login do YouTube enquanto aguarda a conexão', async () => {
  const { controller } = await ready({ mode: 'yt-hang' });
  assert.equal(controller.cancelBusy(), false); // nada em andamento
  const login = controller.youtubeLogin();
  await until(() => controller.snapshot().busy === 'login do YouTube');
  await until(() => controller.snapshot().logs.some((l) => l.line.startsWith('Abrindo o navegador')));
  assert.equal(controller.cancelBusy(), true);
  await assert.rejects(login, /cancelado/);
  assert.equal(controller.snapshot().busy, null); // liberou a tela
  assert.notEqual(controller.snapshot().youtube.status, 'connected');
});

test('a pasta das músicas: valida, grava, sobrevive ao reinício e não muda com a sessão rodando', async () => {
  const { controller, dataDir } = await ready();
  const target = join(await mkdtemp(join(tmpdir(), 'singalong-lib-')), 'minhas musicas');
  const snap = await controller.setLibraryDir(target);
  assert.equal(snap.libraryDir, target);
  assert.equal(JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf8')).library_dir, target);
  await assert.rejects(controller.setLibraryDir(''), /Escolha uma pasta/);
  await assert.rejects(controller.setLibraryDir(join(dataDir, 'config.json', 'dentro-de-um-arquivo')), /Não consigo gravar/);

  sessionOpen = true;
  const seen = [];
  const spy = createController({
    dataDir,
    launcher: (root, args, env) => { seen.push(env.STORAGE_ROOT); return [process.execPath, [FAKE, ...args], { env: { ...process.env, ...env } }]; },
    assembleImpl: async () => ({ engine: 'cpu' }),
    pollMs: 1000,
  });
  await mkdir(join(dataDir, 'engine'), { recursive: true });
  await writeFile(join(dataDir, 'engine', 'engine.json'), JSON.stringify({ complete: true, engine: 'cpu' }));
  await spy.init();
  await spy.startAgent({ nickname: 'G' });
  assert.equal(seen[0], target); // o agente grava as músicas na pasta escolhida
  await assert.rejects(spy.setLibraryDir(join(dataDir, 'outra')), /Encerre a sessão/);
  await spy.stopAgent();
  sessionOpen = false;
});

test('trocar a placa de vídeo pede ao motor para trocar (só com a sessão parada) e mostra o progresso', async () => {
  const calls = [];
  const { controller } = await ready({ assembleImpl: async (options) => { calls.push(options); options.onProgress?.({ label: 'Instalando torch' }); return { engine: options.engine === 'auto' ? 'cu121' : options.engine, engine_reason: 'teste' }; } });
  const snap = await controller.buildEngine({ engine: 'cpu', switchEngine: true });
  assert.equal(calls.at(-1).switchEngine, true);
  assert.equal(calls.at(-1).engine, 'cpu');
  assert.equal(snap.engine.kind, 'cpu');
  assert.equal(snap.engine.status, 'ready');

  sessionOpen = true;
  await controller.startAgent({ nickname: 'G' });
  await assert.rejects(controller.buildEngine({ engine: 'cu121', switchEngine: true }), /Encerre a sessão/);
  await controller.stopAgent();
  sessionOpen = false;
});

test('o microfone escolhido fica guardado, é limpo ao voltar ao padrão e entra no estado', async () => {
  const { controller, dataDir } = await ready();
  assert.equal(controller.snapshot().microphone, null);
  const snap = await controller.setSettings({ microphone: { id: 'abc123', label: 'Microfone USB' } });
  assert.deepEqual(snap.microphone, { id: 'abc123', label: 'Microfone USB' });
  assert.equal(JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf8')).microphone.id, 'abc123');
  assert.equal((await controller.setSettings({ microphone: { id: '', label: 'x' } })).microphone, null);
  assert.equal((await controller.setSettings({ microphone: null })).microphone, null);
});

test('pedir o código por e-mail: valida o e-mail, usa o servidor informado e mostra a resposta', async () => {
  const { controller } = await make();
  await controller.init();
  const before = calls.length;
  const answer = await controller.requestCode({ server: base, email: '  Dona@Exemplo.com ' });
  assert.match(answer.message, /instantes/);
  const call = calls.slice(before).find((c) => c.url === '/agent/v1/pair/request');
  assert.deepEqual(call.body, { email: 'Dona@Exemplo.com' });
  assert.equal(call.auth, null); // sem token: ainda não está pareado
  assert.equal(controller.snapshot().server, ''); // pedir o código não "pareia" nem grava o servidor
  for (const bad of ['', 'lixo', 'a@b']) await assert.rejects(controller.requestCode({ server: base, email: bad }), /e-mail válido/);
  await assert.rejects(controller.requestCode({ server: 'http://exemplo.org', email: 'a@b.com' }), /https/);
  await assert.rejects(controller.requestCode({ server: base, email: 'sem-servico@exemplo.com' }), /não envia códigos/);
  assert.equal(controller.snapshot().defaultServer, 'https://singalong.duckdns.org');
});

test('o app mostra que as músicas deste computador vão para a nuvem quando o servidor autoriza', async () => {
  const { controller } = await ready();
  sessionOpen = true;
  cloudOn = true;
  await controller.startAgent({ nickname: 'G' });
  await until(() => controller.snapshot().agent.status === 'online');
  assert.equal(controller.snapshot().agent.cloud, true);
  await controller.stopAgent();
  cloudOn = false;
  sessionOpen = true; // o servidor de mentira fecha a sessão ao encerrar
  await controller.startAgent({ nickname: 'G' });
  await until(() => controller.snapshot().agent.status === 'online');
  assert.equal(controller.snapshot().agent.cloud, false);
  await controller.stopAgent();
  sessionOpen = false;
});

test('o aviso de atualização é conferido de novo (no máximo uma vez por dia) e não só ao abrir', async () => {
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
  await controller.pair({ server: base, code: 'BOM-CODIGO', name: 'PC' });
  versionAnswer = { status: 'ok' };
  await controller.checkUpdate();
  assert.equal(controller.snapshot().update.status, 'ok');

  versionAnswer = { status: 'update_available', latest: '9.0.0', notes: 'Novidade', url: `${base}/baixar` }; // o servidor anuncia depois
  clock += 23 * 60 * 60_000; // 23 horas depois: ainda é cedo, não pergunta de novo
  await controller.refreshUpdate();
  assert.equal(controller.snapshot().update.status, 'ok');
  clock += 2 * 60 * 60_000; // passou de 24 horas: pergunta e o aviso aparece
  await controller.refreshUpdate();
  assert.equal(controller.snapshot().update.status, 'update_available');
  versionAnswer = { status: 'ok' };
});

test('a escolha da primeira sessão (placa de vídeo e microfone) é lembrada e só vale como feita quando marcada', async () => {
  const { controller, dataDir } = await ready();
  assert.equal(controller.snapshot().setupDone, false);
  assert.equal((await controller.setSettings({ setupDone: 'sim' })).setupDone, false); // só `true` vale
  const snap = await controller.setSettings({ microphone: { id: 'abc', label: 'USB' }, setupDone: true });
  assert.equal(snap.setupDone, true);
  assert.equal(JSON.parse(await readFile(join(dataDir, 'config.json'), 'utf8')).setup_done, true);
  assert.equal((await controller.setSettings({ nickname: 'Ana' })).setupDone, true); // outras mudanças não a desfazem
});

test('estatísticas: junta o que o servidor guardou das salas com o que há na biblioteca deste computador', async () => {
  const { controller, dataDir } = await make();
  await assert.rejects(() => controller.stats(), (error) => error.code === 'not_paired');
  await controller.pair({ server: base, code: 'BOM-CODIGO', name: 'PC' });

  // uma biblioteca com duas músicas prontas (meta.json) e uma pasta parcial (sem meta.json: não conta)
  const cache = join(dataDir, 'library', 'cache');
  for (const [id, size, timings] of [['aaaaaaaaaaa', 1000, { download: 10, separate: 50 }], ['bbbbbbbbbbb', 3000, { download: 20, separate: 100 }]]) {
    await mkdir(join(cache, id), { recursive: true });
    await writeFile(join(cache, id, 'instrumental.mp3'), Buffer.alloc(size));
    await writeFile(join(cache, id, 'meta.json'), JSON.stringify({ title: `Música ${id[0]}`, artist: 'Artista', timings_s: timings }));
  }
  await mkdir(join(cache, 'ccccccccccc'), { recursive: true });
  await writeFile(join(cache, 'ccccccccccc', 'instrumental.mp3'), Buffer.alloc(999));

  const result = await controller.stats({ days: 90 });
  assert.equal(result.server.days, 90);
  assert.equal(result.server.totals.songs, 3);
  assert.equal(calls.findLast((c) => c.url.startsWith('/agent/v1/stats')).auth, 'Bearer tok-1');
  assert.equal(result.library.songs, 2);
  assert.ok(result.library.bytes >= 4000 && result.library.bytes < 4400); // o mp3 e o meta.json de cada uma
  assert.equal(result.library.avg_prepare_s, 90); // (60 + 120) / 2
  assert.equal(result.library.biggest[0].title, 'Música b');

  assert.equal((await controller.stats({ days: 3 })).server.days, 30); // período fora da lista volta ao padrão
  const empty = await make();
  await empty.controller.pair({ server: base, code: 'BOM-CODIGO', name: 'PC' });
  assert.deepEqual((await empty.controller.stats()).library, { songs: 0, bytes: 0, avg_prepare_s: null, biggest: [] }); // biblioteca ainda vazia
});
