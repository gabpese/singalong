// Montagem do motor com tudo falso (sem rede, sem pip): a ordem das etapas, a retomada, a escolha cpu/cu121 e a volta para a CPU.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assemble, loadManifest, manifestHash, refreshWorker, resolveManifest } from '../src/assemble.js';
import { extract, installFiles, resolveGlob, tarCommand } from '../src/extract.js';
import { launchEnv, paths, readState, workerCommand } from '../src/engine.js';

process.env.SINGALONG_ENGINE_ANY_PLATFORM = '1';

const sha = (buffer) => createHash('sha256').update(buffer).digest('hex');
const canTar = spawnSync(tarCommand(), ['--version']).status === 0;

/** Cria um .tar.gz de verdade com os arquivos dados ({ "python/python.exe": "..." }). */
async function makeTarGz(dir, name, files) {
  const src = join(dir, `src-${name}`);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(src, path, '..'), { recursive: true });
    await writeFile(join(src, path), content);
  }
  const out = join(dir, name);
  assert.equal(spawnSync(tarCommand(), ['-czf', out, '-C', src, '.']).status, 0);
  return out;
}

test('resolveGlob entende "*" de um nível e nunca sai da pasta', { skip: !canTar }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'singalong-glob-'));
  await mkdir(join(dir, 'ffmpeg-8.1-gpl', 'bin'), { recursive: true });
  await writeFile(join(dir, 'ffmpeg-8.1-gpl', 'bin', 'ffmpeg.exe'), 'x');
  assert.equal(await resolveGlob(dir, '*/bin/ffmpeg.exe'), join(dir, 'ffmpeg-8.1-gpl', 'bin', 'ffmpeg.exe'));
  assert.equal(await resolveGlob(dir, '*/bin/nao-existe.exe'), null);
  assert.equal(await resolveGlob(dir, '../fora'), null);
  await assert.rejects(installFiles(dir, [{ from: '*/bin/ffmpeg.exe', to: '../escapou.exe' }], join(dir, 'motor')), /fora do motor/);
});

test('extract + installFiles copiam só o que o manifesto pede', { skip: !canTar }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'singalong-ext-'));
  const archive = await makeTarGz(dir, 'a.tar.gz', { 'topo/bin/ffmpeg.exe': 'FF', 'topo/bin/ffplay.exe': 'PLAY', 'topo/LICENSE.txt': 'GPL' });
  await extract(archive, join(dir, 'out'));
  await installFiles(join(dir, 'out'), [{ from: '*/bin/ffmpeg.exe', to: 'bin/ffmpeg.exe' }, { from: '*/LICENSE.txt', to: 'licenses/x.txt' }], join(dir, 'motor'));
  assert.equal(await readFile(join(dir, 'motor', 'bin', 'ffmpeg.exe'), 'utf8'), 'FF');
  assert.equal(await stat(join(dir, 'motor', 'bin', 'ffplay.exe')).catch(() => null), null);
  await assert.rejects(extract(join(dir, 'nao-existe.tar.gz'), join(dir, 'out2')), /extrair/);
});

/** Um servidor de mentira: serve os "componentes" e registra os comandos que o montador pediria ao Python. */
async function scenario(t, { hardware = { engine: 'cu121', reason: 'RTX', gpus: [{ name: 'RTX' }], cpu_cores: 8, ram_mb: 16000 }, selftest = { ok: true }, failOn } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'singalong-asm-'));
  const pyArchive = await makeTarGz(dir, 'py.tar.gz', { 'python/python.exe': 'PY' });
  const toolArchive = await makeTarGz(dir, 'tool.tar.gz', { 'deno.exe': 'DENO' });
  const worker = join(dir, 'worker');
  await mkdir(join(worker, 'singalong_worker'), { recursive: true });
  await writeFile(join(worker, 'singalong_worker', '__init__.py'), '');
  await writeFile(join(worker, 'requirements.txt'), 'redis\n');
  const files = { '/py': await readFile(pyArchive), '/tool': await readFile(toolArchive) };
  const manifest = {
    pack_version: '1',
    platform: 'any',
    components: {
      python: { version: '3.11', url: 'http://x.test/py', sha256: sha(files['/py']), files: [{ from: 'python', to: 'python' }] },
      deno: { version: '2', url: 'http://x.test/tool', sha256: sha(files['/tool']), files: [{ from: 'deno.exe', to: 'bin/deno.exe' }] },
    },
    torch: { version: '2.5.1', index: 'https://idx/{engine}' },
    pip: [{ name: 'torch', args: ['torch==2.5.1'], torchIndex: true }, { name: 'req', requirements: true }, { name: 'extra', args: ['einops==1'] }],
  };
  const commands = [];
  const downloads = [];
  const fetchImpl = async (url) => {
    downloads.push(url);
    const body = files[new URL(url).pathname];
    return new Response(body, { status: 200, headers: { 'content-length': String(body.length) } });
  };
  let torch = '2.5.1+cu121';
  const runImpl = async (command, args) => {
    commands.push(args.join(' '));
    if (failOn && args.join(' ').includes(failOn)) throw new Error('pip falhou');
    const text = args.join(' ');
    if (text.includes('hardware.probe')) return JSON.stringify(hardware);
    if (text.includes('gpu_selftest')) return JSON.stringify(selftest);
    if (text.includes('torch.__version__')) return `${torch}\n`;
    if (text.includes('--index-url https://idx/cpu')) torch = '2.5.1+cpu';
    return '';
  };
  return { dir, root: join(dir, 'motor'), manifest, worker, fetchImpl, runImpl, commands, downloads };
}

test('monta o motor: componentes, código do worker, pip com o índice do hardware e estado salvo', { skip: !canTar }, async (t) => {
  const s = await scenario(t);
  const steps = [];
  const state = await assemble({ root: s.root, manifest: s.manifest, workerSource: s.worker, fetchImpl: s.fetchImpl, runImpl: s.runImpl, onProgress: (p) => steps.push(p.step) });
  assert.equal(state.engine, 'cu121');
  assert.equal(state.complete, true);
  assert.equal(await readFile(join(s.root, 'python', 'python.exe'), 'utf8'), 'PY');
  assert.equal(await readFile(join(s.root, 'bin', 'deno.exe'), 'utf8'), 'DENO');
  assert.ok(await stat(join(s.root, 'app', 'singalong_worker', '__init__.py')));
  assert.ok(s.commands.some((c) => c.includes('torch==2.5.1') && c.includes('--index-url https://idx/cu121')));
  assert.ok(s.commands.some((c) => c.includes('-r') && c.includes('requirements.txt')));
  assert.equal(steps.indexOf('component:python') < steps.indexOf('hardware'), true); // o Python vem antes da verificação
  assert.equal((await readState(s.root)).torch_installed, '2.5.1+cu121');
});

test('o hardware sem placa NVIDIA escolhe CPU, e --engine força a escolha', { skip: !canTar }, async (t) => {
  const none = await scenario(t, { hardware: { engine: 'cpu', reason: 'nenhuma placa NVIDIA', gpus: [], cpu_cores: 4, ram_mb: 8000 } });
  assert.equal((await assemble({ root: none.root, manifest: none.manifest, workerSource: none.worker, fetchImpl: none.fetchImpl, runImpl: none.runImpl })).engine, 'cpu');
  assert.ok(none.commands.some((c) => c.includes('--index-url https://idx/cpu')));

  const forced = await scenario(t);
  const state = await assemble({ root: forced.root, manifest: forced.manifest, workerSource: forced.worker, fetchImpl: forced.fetchImpl, runImpl: forced.runImpl, engine: 'cpu' });
  assert.equal(state.engine, 'cpu');
  assert.equal(state.complete, true);
});

test('a GPU falha no teste real: volta para a CPU, troca só o torch e registra o motivo', { skip: !canTar }, async (t) => {
  const s = await scenario(t, { selftest: { ok: false, detail: 'sem kernels para sm_120' } });
  const state = await assemble({ root: s.root, manifest: s.manifest, workerSource: s.worker, fetchImpl: s.fetchImpl, runImpl: s.runImpl });
  assert.equal(state.engine, 'cpu');
  assert.equal(state.fallback_reason, 'sem kernels para sm_120');
  const torchInstalls = s.commands.filter((c) => c.includes('torch==2.5.1') && c.includes('install'));
  assert.equal(torchInstalls.length, 2);
  assert.ok(torchInstalls[1].includes('--force-reinstall') && torchInstalls[1].includes('https://idx/cpu'));
  assert.equal(s.commands.filter((c) => c.includes('einops')).length, 1); // os outros pacotes não são refeitos
  assert.equal(state.torch_installed, '2.5.1+cpu');
});

test('retoma: se o pip falha no meio, a próxima execução não baixa nem instala de novo o que já foi feito', { skip: !canTar }, async (t) => {
  const s = await scenario(t, { failOn: 'einops' });
  await assert.rejects(assemble({ root: s.root, manifest: s.manifest, workerSource: s.worker, fetchImpl: s.fetchImpl, runImpl: s.runImpl }), /pip falhou/);
  assert.equal((await readState(s.root)).steps['pip:1'], true);
  assert.equal(s.downloads.length, 2);

  const retry = await scenario(t);
  const again = { ...s, runImpl: retry.runImpl, commands: retry.commands };
  const state = await assemble({ root: s.root, manifest: s.manifest, workerSource: s.worker, fetchImpl: s.fetchImpl, runImpl: again.runImpl });
  assert.equal(state.complete, true);
  assert.equal(s.downloads.length, 2); // nada baixado outra vez
  assert.equal(retry.commands.filter((c) => c.includes('torch==2.5.1') && c.includes('install')).length, 0); // torch não reinstalado
  assert.equal(retry.commands.filter((c) => c.includes('einops')).length, 1); // só o que faltava
});

test('um manifesto novo (componente atualizado) refaz as etapas', { skip: !canTar }, async (t) => {
  const s = await scenario(t);
  await assemble({ root: s.root, manifest: s.manifest, workerSource: s.worker, fetchImpl: s.fetchImpl, runImpl: s.runImpl });
  const changed = structuredClone(s.manifest);
  changed.components.deno.version = '3';
  assert.notEqual(manifestHash(changed), manifestHash(s.manifest));
  s.downloads.length = 0;
  await assemble({ root: s.root, manifest: changed, workerSource: s.worker, fetchImpl: s.fetchImpl, runImpl: s.runImpl });
  assert.equal(s.downloads.length, 0); // os arquivos ainda estão no cache de downloads (hash conferido)
  assert.equal((await readState(s.root)).components.deno.version, '3');
});

test('um download adulterado (hash diferente) interrompe a montagem', { skip: !canTar }, async (t) => {
  const s = await scenario(t);
  s.manifest.components.deno.sha256 = 'a'.repeat(64);
  await assert.rejects(assemble({ root: s.root, manifest: s.manifest, workerSource: s.worker, fetchImpl: s.fetchImpl, runImpl: s.runImpl }), /não confere/);
  assert.equal(await stat(join(s.root, 'bin', 'deno.exe')).catch(() => null), null);
});

test('plataforma errada é recusada com uma mensagem clara', async () => {
  delete process.env.SINGALONG_ENGINE_ANY_PLATFORM;
  try {
    await assert.rejects(assemble({ root: join(tmpdir(), 'x'), manifest: { platform: 'plan9-mips', components: {}, pip: [] } }), /plan9-mips/);
  } finally {
    process.env.SINGALONG_ENGINE_ANY_PLATFORM = '1';
  }
});

test('o ambiente do worker põe o ffmpeg do motor na frente do PATH só para o processo dele', () => {
  const env = launchEnv('/motor', { AGENT_URL: 'https://x' }, { PATH: '/usr/bin', HOME: '/h' });
  const p = paths('/motor');
  assert.ok(env.PATH.startsWith(p.bin));
  assert.ok(env.PATH.endsWith('/usr/bin'));
  assert.equal(env.PYTHONPATH, p.app);
  assert.equal(env.PYTHONNOUSERSITE, '1');
  assert.equal(env.AGENT_URL, 'https://x');
  const [exe, args, options] = workerCommand('/motor', ['--version']);
  assert.equal(exe, p.python);
  assert.deepEqual(args, ['-m', 'singalong_worker', '--version']);
  assert.equal(options.cwd, p.app);
  assert.equal(process.env.PYTHONPATH === p.app, false); // o ambiente deste processo não foi alterado
});

test('o manifesto de verdade: cada sistema tem Python, ffmpeg e deno com URL https, SHA-256 e arquivos a instalar', async () => {
  const raw = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(raw.platforms), ['win32-x64', 'linux-x64']);
  for (const [platform, { components }] of Object.entries(raw.platforms)) {
    assert.deepEqual(Object.keys(components), ['python', 'ffmpeg', 'deno'], platform); // o Python vem primeiro (a verificação de hardware usa ele)
    for (const [name, c] of Object.entries(components)) {
      assert.match(c.url, /^https:\/\//, `${platform} ${name}`);
      assert.match(c.sha256, /^[0-9a-f]{64}$/, `${platform} ${name}`);
      assert.ok(c.files.length > 0, `${platform} ${name}`);
    }
    assert.ok(components.python.url.includes('python-build-standalone'), platform);
    assert.ok(components.ffmpeg.version.includes('GPL'), platform);
  }
  assert.match(raw.platforms['win32-x64'].components.ffmpeg.url, /win64-gpl/);
  assert.match(raw.platforms['linux-x64'].components.ffmpeg.url, /linux64-gpl/);
  assert.deepEqual(raw.platforms['linux-x64'].components.ffmpeg.files.map((f) => f.to), ['bin/ffmpeg', 'bin/ffprobe', 'licenses/ffmpeg-LICENSE.txt']); // sem .exe
  assert.equal(raw.torch.version, '2.5.1'); // o Demucs 4.0.1 quebra com outros
});

test('o manifesto resolvido: o Windows continua com o mesmo hash de antes (não refaz o motor de quem já o montou) e sistema sem motor é recusado', async () => {
  const windows = await loadManifest(undefined, 'win32-x64');
  assert.equal(windows.platform, 'win32-x64');
  assert.equal(manifestHash(windows), '28529b9dc9631f40'); // o hash do motor montado antes da F26
  const linux = await loadManifest(undefined, 'linux-x64');
  assert.equal(linux.platform, 'linux-x64');
  assert.notEqual(manifestHash(linux), manifestHash(windows));
  assert.deepEqual(Object.keys(linux), ['pack_version', 'platform', 'comment', 'components', 'torch', 'pip']);
  assert.throws(() => resolveManifest({ platforms: { 'win32-x64': { components: {} } } }, 'darwin-x64'), /Não há motor para este computador \(darwin-x64\).*win32-x64/);
});

test('extrair .zip e .tar.xz: sem unzip nem xz (Linux enxuto) o Python do próprio motor abre o arquivo', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'singalong-zip-'));
  const python = join(dir, 'python3');
  await writeFile(python, '');
  const calls = [];
  const run = (command) => {
    calls.push(command);
    return command === python ? { status: 0 } : { status: 1, error: new Error(`${command} não existe`) };
  };
  await extract(join(dir, 'x.zip'), join(dir, 'saida'), { run, python });
  assert.equal(calls.length, 3);
  assert.equal(calls[2], python);
  calls.length = 0;
  const modules = [];
  await extract(join(dir, 'ffmpeg.tar.xz'), join(dir, 'saida3'), { run: (command, args) => { calls.push(command); modules.push(args[1]); return command === python ? { status: 0 } : { status: 2, stderr: 'xz: Cannot exec' }; }, python });
  assert.deepEqual(calls.length, 2); // o tar falha (sem xz) e o Python abre com o tarfile
  assert.equal(modules[1], 'tarfile');
  await assert.rejects(extract(join(dir, 'x.zip'), join(dir, 'saida2'), { run: () => ({ status: 1, stderr: 'ruim' }), python }), /Não consegui extrair/);
});

test('trocar de motor depois de montado: só o torch é reinstalado (com --force-reinstall) e o teste da GPU refeito', { skip: !canTar }, async (t) => {
  const s = await scenario(t);
  await assemble({ root: s.root, manifest: s.manifest, workerSource: s.worker, fetchImpl: s.fetchImpl, runImpl: s.runImpl });
  assert.equal((await readState(s.root)).engine, 'cu121');
  s.commands.length = 0;
  s.downloads.length = 0;

  const state = await assemble({ root: s.root, manifest: s.manifest, workerSource: s.worker, fetchImpl: s.fetchImpl, runImpl: s.runImpl, engine: 'cpu', switchEngine: true });
  assert.equal(state.engine, 'cpu');
  assert.equal(state.complete, true);
  const torch = s.commands.filter((c) => c.includes('torch==2.5.1') && c.includes('install'));
  assert.equal(torch.length, 1);
  assert.ok(torch[0].includes('--force-reinstall') && torch[0].includes('https://idx/cpu'));
  assert.equal(s.commands.filter((c) => c.includes('einops')).length, 0); // o resto não foi refeito
  assert.equal(s.downloads.length, 0);
  assert.equal(state.torch_installed, '2.5.1+cpu');

  // pedir o mesmo motor que já está instalado não faz nada
  s.commands.length = 0;
  await assemble({ root: s.root, manifest: s.manifest, workerSource: s.worker, fetchImpl: s.fetchImpl, runImpl: s.runImpl, engine: 'cpu', switchEngine: true });
  assert.equal(s.commands.filter((c) => c.includes('install')).length, 0);
});

test('depois de uma atualização do app, o código do worker dentro do motor é trocado (e só quando a versão difere)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'singalong-refresh-'));
  const source = join(dir, 'worker');
  const root = join(dir, 'motor');
  const put = async (base, version, extra = {}) => {
    await mkdir(join(base, 'singalong_worker'), { recursive: true });
    await writeFile(join(base, 'singalong_worker', 'version.py'), `__version__ = "${version}"\n`);
    await writeFile(join(base, 'requirements.txt'), `req-${version}\n`);
    for (const [name, text] of Object.entries(extra)) await writeFile(join(base, 'singalong_worker', name), text);
  };
  await put(join(root, 'app'), '0.4.0', { 'velho.py': 'saiu da versão nova' });
  await put(source, '1.2.5', { 'cloud.py': 'novo' });

  assert.deepEqual(await refreshWorker({ root, workerSource: source }), { updated: true, from: '0.4.0', to: '1.2.5' });
  assert.equal(await readFile(join(root, 'app', 'singalong_worker', 'cloud.py'), 'utf8'), 'novo');
  assert.equal(await readFile(join(root, 'app', 'requirements.txt'), 'utf8'), 'req-1.2.5\n');
  await assert.rejects(stat(join(root, 'app', 'singalong_worker', 'velho.py')), { code: 'ENOENT' }); // o que saiu da versão nova não fica para trás
  assert.deepEqual(await refreshWorker({ root, workerSource: source }), { updated: false, from: '1.2.5', to: '1.2.5' }); // já em dia: não mexe
  assert.deepEqual(await refreshWorker({ root, workerSource: join(dir, 'nao-existe') }), { updated: false, from: null, to: null }); // sem fonte: não faz nada
});

test('installFiles mantém os links relativos (o bin/python3 do Linux aponta para python3.11, e a pasta temporária é apagada depois)', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'singalong-link-'));
  const extracted = join(dir, 'extraido');
  await mkdir(join(extracted, 'python', 'bin'), { recursive: true });
  await writeFile(join(extracted, 'python', 'bin', 'python3.11'), 'PY');
  await symlink('python3.11', join(extracted, 'python', 'bin', 'python3'));
  const root = join(dir, 'motor');
  await installFiles(extracted, [{ from: 'python', to: 'python' }], root);
  await rm(extracted, { recursive: true, force: true }); // como o montador faz depois de instalar
  assert.equal(await readlink(join(root, 'python', 'bin', 'python3')), 'python3.11');
  assert.equal(await readFile(join(root, 'python', 'bin', 'python3'), 'utf8'), 'PY'); // o link ainda abre
});
