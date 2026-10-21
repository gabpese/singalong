// Assembling the engine with everything faked (no network, no pip): the order of the steps, resuming, the cpu/cu121 choice and
// the fallback to the CPU.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assemble, isAccelerated, loadManifest, type Manifest, manifestHash, refreshWorker, resolveManifest, torchIndexFor } from '../src/assemble.ts';
import { extract, installFiles, resolveGlob, tarCommand } from '../src/extract.ts';
import { engineEnv, launchEnv, paths, readState, workerCommand } from '../src/engine.ts';

process.env.SINGALONG_ENGINE_ANY_PLATFORM = '1';

const sha = (buffer: Buffer) => createHash('sha256').update(buffer).digest('hex');
const canTar = spawnSync(tarCommand(), ['--version']).status === 0;

/** Makes a real .tar.gz with the given files ({ "python/python.exe": "..." }). */
async function makeTarGz(dir: string, name: string, files: Record<string, string>) {
  const src = join(dir, `src-${name}`);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(join(src, path, '..'), { recursive: true });
    await writeFile(join(src, path), content);
  }
  const out = join(dir, name);
  assert.equal(spawnSync(tarCommand(), ['-czf', out, '-C', src, '.']).status, 0);
  return out;
}

/** A stand-in for spawnSync that answers each command with `answer`. */
const fakeSpawn = (answer: (command: string, args: string[]) => { status: number; error?: Error; stderr?: string }) => answer as unknown as typeof spawnSync;

test('resolveGlob understands a one-level "*" and never leaves the folder', { skip: !canTar }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'singalong-glob-'));
  await mkdir(join(dir, 'ffmpeg-8.1-gpl', 'bin'), { recursive: true });
  await writeFile(join(dir, 'ffmpeg-8.1-gpl', 'bin', 'ffmpeg.exe'), 'x');
  assert.equal(await resolveGlob(dir, '*/bin/ffmpeg.exe'), join(dir, 'ffmpeg-8.1-gpl', 'bin', 'ffmpeg.exe'));
  assert.equal(await resolveGlob(dir, '*/bin/missing.exe'), null);
  assert.equal(await resolveGlob(dir, '../outside'), null);
  await assert.rejects(installFiles(dir, [{ from: '*/bin/ffmpeg.exe', to: '../escaped.exe' }], join(dir, 'engine')), /fora do motor/);
});

test('extract and installFiles copy only what the manifest asks for', { skip: !canTar }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'singalong-ext-'));
  const archive = await makeTarGz(dir, 'a.tar.gz', { 'top/bin/ffmpeg.exe': 'FF', 'top/bin/ffplay.exe': 'PLAY', 'top/LICENSE.txt': 'GPL' });
  await extract(archive, join(dir, 'out'));
  await installFiles(join(dir, 'out'), [{ from: '*/bin/ffmpeg.exe', to: 'bin/ffmpeg.exe' }, { from: '*/LICENSE.txt', to: 'licenses/x.txt' }], join(dir, 'engine'));
  assert.equal(await readFile(join(dir, 'engine', 'bin', 'ffmpeg.exe'), 'utf8'), 'FF');
  assert.equal(await stat(join(dir, 'engine', 'bin', 'ffplay.exe')).catch(() => null), null);
  await assert.rejects(extract(join(dir, 'missing.tar.gz'), join(dir, 'out2')), /extrair/);
});

interface ScenarioOptions {
  hardware?: { engine: string; reason: string; gpus: { name: string }[]; cpu_cores: number; ram_mb: number };
  selftest?: { ok: boolean; detail?: string };
  failOn?: string;
}

/** A fake server: it serves the "components" and records the commands the assembler would ask Python for. */
async function scenario({ hardware = { engine: 'cu121', reason: 'RTX', gpus: [{ name: 'RTX' }], cpu_cores: 8, ram_mb: 16000 }, selftest = { ok: true }, failOn }: ScenarioOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'singalong-asm-'));
  const pyArchive = await makeTarGz(dir, 'py.tar.gz', { 'python/python.exe': 'PY' });
  const toolArchive = await makeTarGz(dir, 'tool.tar.gz', { 'deno.exe': 'DENO' });
  const worker = join(dir, 'worker');
  await mkdir(join(worker, 'singalong_worker'), { recursive: true });
  await writeFile(join(worker, 'singalong_worker', '__init__.py'), '');
  await writeFile(join(worker, 'requirements.txt'), 'redis\n');
  const files: Record<string, Buffer> = { '/py': await readFile(pyArchive), '/tool': await readFile(toolArchive) };
  const manifest: Manifest = {
    pack_version: '1',
    platform: 'any',
    components: {
      python: { version: '3.11', url: 'http://x.test/py', sha256: sha(files['/py']), files: [{ from: 'python', to: 'python' }] },
      deno: { version: '2', url: 'http://x.test/tool', sha256: sha(files['/tool']), files: [{ from: 'deno.exe', to: 'bin/deno.exe' }] },
    },
    torch: { version: '2.5.1', index: 'https://idx/{engine}' },
    pip: [{ name: 'torch', args: ['torch==2.5.1'], torchIndex: true }, { name: 'req', requirements: true }, { name: 'extra', args: ['einops==1'] }],
  };
  const commands: string[] = [];
  const downloads: string[] = [];
  const fetchImpl = (async (url: string) => {
    downloads.push(url);
    const body = files[new URL(url).pathname];
    return new Response(new Uint8Array(body), { status: 200, headers: { 'content-length': String(body.length) } });
  }) as typeof fetch;
  let torch = '2.5.1+cu121';
  const runImpl = async (_command: string, args: string[]) => {
    commands.push(args.join(' '));
    if (failOn && args.join(' ').includes(failOn)) throw new Error('pip failed');
    const text = args.join(' ');
    if (text.includes('hardware.probe')) return JSON.stringify(hardware);
    if (text.includes('gpu_selftest')) return JSON.stringify(selftest);
    if (text.includes('torch.__version__')) return `${torch}\n`;
    if (text.includes('--index-url https://idx/cpu')) torch = '2.5.1+cpu';
    return '';
  };
  return { dir, root: join(dir, 'engine'), manifest, worker, fetchImpl, runImpl, commands, downloads };
}

/** The assembly of a scenario, with what it fakes. */
const assembleIn = (s: Awaited<ReturnType<typeof scenario>>, options: { engine?: string; switchEngine?: boolean; manifest?: Manifest } = {}) =>
  assemble({ root: s.root, manifest: s.manifest, workerSource: s.worker, fetchImpl: s.fetchImpl, runImpl: s.runImpl, ...options });

test('assembles the engine: the components, the worker code, pip with the hardware index and the saved state', { skip: !canTar }, async () => {
  const s = await scenario();
  const steps: string[] = [];
  const state = await assemble({ root: s.root, manifest: s.manifest, workerSource: s.worker, fetchImpl: s.fetchImpl, runImpl: s.runImpl, onProgress: (p) => steps.push(p.step) });
  assert.equal(state.engine, 'cu121');
  assert.equal(state.complete, true);
  assert.equal(await readFile(join(s.root, 'python', 'python.exe'), 'utf8'), 'PY');
  assert.equal(await readFile(join(s.root, 'bin', 'deno.exe'), 'utf8'), 'DENO');
  assert.ok(await stat(join(s.root, 'app', 'singalong_worker', '__init__.py')));
  assert.ok(s.commands.some((c) => c.includes('torch==2.5.1') && c.includes('--index-url https://idx/cu121')));
  assert.ok(s.commands.some((c) => c.includes('-r') && c.includes('requirements.txt')));
  assert.equal(steps.indexOf('component:python') < steps.indexOf('hardware'), true); // Python comes before the hardware check
  assert.equal((await readState(s.root))?.torch_installed, '2.5.1+cu121');
});

test('hardware without an NVIDIA card picks the CPU, and --engine forces the choice', { skip: !canTar }, async () => {
  const none = await scenario({ hardware: { engine: 'cpu', reason: 'nenhuma placa NVIDIA', gpus: [], cpu_cores: 4, ram_mb: 8000 } });
  assert.equal((await assembleIn(none)).engine, 'cpu');
  assert.ok(none.commands.some((c) => c.includes('--index-url https://idx/cpu')));

  const forced = await scenario();
  const state = await assembleIn(forced, { engine: 'cpu' });
  assert.equal(state.engine, 'cpu');
  assert.equal(state.complete, true);
});

test('the GPU fails the real test: back to the CPU, only torch is swapped and the reason is recorded', { skip: !canTar }, async () => {
  const s = await scenario({ selftest: { ok: false, detail: 'no kernels for sm_120' } });
  const state = await assembleIn(s);
  assert.equal(state.engine, 'cpu');
  assert.equal(state.fallback_reason, 'no kernels for sm_120');
  const torchInstalls = s.commands.filter((c) => c.includes('torch==2.5.1') && c.includes('install'));
  assert.equal(torchInstalls.length, 2);
  assert.ok(torchInstalls[1].includes('--force-reinstall') && torchInstalls[1].includes('https://idx/cpu'));
  assert.equal(s.commands.filter((c) => c.includes('einops')).length, 1); // the other packages are not redone
  assert.equal(state.torch_installed, '2.5.1+cpu');
});

test('resumes: when pip fails halfway, the next run neither downloads nor installs again what was done', { skip: !canTar }, async () => {
  const s = await scenario({ failOn: 'einops' });
  await assert.rejects(assembleIn(s), /pip failed/);
  assert.equal((await readState(s.root))?.steps['pip:1'], true);
  assert.equal(s.downloads.length, 2);

  const retry = await scenario();
  const state = await assemble({ root: s.root, manifest: s.manifest, workerSource: s.worker, fetchImpl: s.fetchImpl, runImpl: retry.runImpl });
  assert.equal(state.complete, true);
  assert.equal(s.downloads.length, 2); // nothing downloaded again
  assert.equal(retry.commands.filter((c) => c.includes('torch==2.5.1') && c.includes('install')).length, 0); // torch not reinstalled
  assert.equal(retry.commands.filter((c) => c.includes('einops')).length, 1); // only what was missing
});

test('a new manifest (an updated component) redoes the steps', { skip: !canTar }, async () => {
  const s = await scenario();
  await assembleIn(s);
  const changed = structuredClone(s.manifest);
  changed.components.deno.version = '3';
  assert.notEqual(manifestHash(changed), manifestHash(s.manifest));
  s.downloads.length = 0;
  await assembleIn(s, { manifest: changed });
  assert.equal(s.downloads.length, 0); // the files are still in the download cache (hash checked)
  assert.equal((await readState(s.root))?.components.deno.version, '3');
});

test('a tampered download (a different hash) stops the assembly', { skip: !canTar }, async () => {
  const s = await scenario();
  s.manifest.components.deno.sha256 = 'a'.repeat(64);
  await assert.rejects(assembleIn(s), /não confere/);
  assert.equal(await stat(join(s.root, 'bin', 'deno.exe')).catch(() => null), null);
});

test('the wrong platform is refused with a clear message', async () => {
  delete process.env.SINGALONG_ENGINE_ANY_PLATFORM;
  try {
    const manifest = { pack_version: '1', platform: 'plan9-mips', components: {}, torch: { version: '2.5.1', index: '' }, pip: [] };
    await assert.rejects(assemble({ root: join(tmpdir(), 'x'), manifest }), /plan9-mips/);
  } finally {
    process.env.SINGALONG_ENGINE_ANY_PLATFORM = '1';
  }
});

test("the worker's environment puts the engine's ffmpeg first on PATH, only for its own process", () => {
  const env = launchEnv('/engine', { AGENT_URL: 'https://x' }, { PATH: '/usr/bin', HOME: '/h' });
  const p = paths('/engine');
  assert.ok(env.PATH?.startsWith(p.bin));
  assert.ok(env.PATH?.endsWith('/usr/bin'));
  assert.equal(env.PYTHONPATH, p.app);
  assert.equal(env.PYTHONNOUSERSITE, '1');
  assert.equal(env.AGENT_URL, 'https://x');
  const [exe, args, options] = workerCommand('/engine', ['--version']);
  assert.equal(exe, p.python);
  assert.deepEqual(args, ['-m', 'singalong_worker', '--version']);
  assert.equal(options.cwd, p.app);
  assert.equal(process.env.PYTHONPATH === p.app, false); // this process's environment did not change
});

test('the real manifest: every system has Python, ffmpeg and deno with an https URL, a SHA-256 and files to install', async () => {
  const raw = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(raw.platforms), ['win32-x64', 'linux-x64', 'darwin-arm64']);
  for (const [platform, { components }] of Object.entries<{ components: Manifest['components'] }>(raw.platforms)) {
    // Python comes first (the hardware check uses it); on macOS ffprobe is a file of its own
    assert.deepEqual(Object.keys(components), platform === 'darwin-arm64' ? ['python', 'ffmpeg', 'ffprobe', 'deno'] : ['python', 'ffmpeg', 'deno'], platform);
    for (const [name, c] of Object.entries(components)) {
      assert.match(c.url, /^https:\/\//, `${platform} ${name}`);
      assert.match(c.sha256, /^[0-9a-f]{64}$/, `${platform} ${name}`);
      assert.ok(c.files.length > 0, `${platform} ${name}`);
    }
    assert.ok(components.python.url.includes('python-build-standalone'), platform);
    assert.ok(components.ffmpeg.version.includes('GPL'), platform);
    assert.ok(Object.values(components).every((c) => c.files.every((f) => !f.to.endsWith('.exe') || platform === 'win32-x64')), platform); // only Windows has .exe
  }
  assert.match(raw.platforms['win32-x64'].components.ffmpeg.url, /win64-gpl/);
  assert.match(raw.platforms['linux-x64'].components.ffmpeg.url, /linux64-gpl/);
  assert.match(raw.platforms['darwin-arm64'].components.python.url, /aarch64-apple-darwin/);
  assert.match(raw.platforms['darwin-arm64'].components.ffmpeg.url, /macos\/arm64/);
  assert.match(raw.platforms['darwin-arm64'].components.deno.url, /aarch64-apple-darwin/);
  assert.deepEqual(raw.platforms['linux-x64'].components.ffmpeg.files.map((f: { to: string }) => f.to), ['bin/ffmpeg', 'bin/ffprobe', 'licenses/ffmpeg-LICENSE.txt']); // no .exe
  assert.equal(raw.torch.version, '2.5.1'); // Demucs 4.0.1 breaks with others
});

test('the resolved manifest: Windows keeps the same hash as before (an engine already assembled is not redone), and a system without an engine is refused', async () => {
  const windows = await loadManifest(undefined, 'win32-x64');
  assert.equal(windows.platform, 'win32-x64');
  assert.equal(manifestHash(windows), '28529b9dc9631f40'); // the hash of the engine assembled before F26
  const linux = await loadManifest(undefined, 'linux-x64');
  assert.equal(linux.platform, 'linux-x64');
  assert.notEqual(manifestHash(linux), manifestHash(windows));
  assert.deepEqual(Object.keys(linux), ['pack_version', 'platform', 'comment', 'components', 'torch', 'pip']);
  const raw = { pack_version: '1', platforms: { 'win32-x64': { components: {} } }, torch: { version: '2.5.1', index: '' }, pip: [] };
  assert.throws(() => resolveManifest(raw, 'darwin-x64'), /Não há motor para este computador \(darwin-x64\).*win32-x64/);
});

test("extracting .zip and .tar.xz without unzip or xz (a lean Linux): the engine's own Python opens the file", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'singalong-zip-'));
  const python = join(dir, 'python3');
  await writeFile(python, '');
  const calls: string[] = [];
  const run = fakeSpawn((command) => {
    calls.push(command);
    return command === python ? { status: 0 } : { status: 1, error: new Error(`${command} does not exist`) };
  });
  await extract(join(dir, 'x.zip'), join(dir, 'out'), { run, python });
  assert.equal(calls.length, 3);
  assert.equal(calls[2], python);
  calls.length = 0;
  const modules: string[] = [];
  const noXz = fakeSpawn((command, args) => {
    calls.push(command);
    modules.push(args[1]);
    return command === python ? { status: 0 } : { status: 2, stderr: 'xz: Cannot exec' };
  });
  await extract(join(dir, 'ffmpeg.tar.xz'), join(dir, 'out3'), { run: noXz, python });
  assert.deepEqual(calls.length, 2); // tar fails (no xz) and Python opens it with tarfile
  assert.equal(modules[1], 'tarfile');
  await assert.rejects(extract(join(dir, 'x.zip'), join(dir, 'out2'), { run: fakeSpawn(() => ({ status: 1, stderr: 'bad' })), python }), /Não consegui extrair/);
});

test('switching engines after the assembly: only torch is reinstalled (with --force-reinstall) and the GPU test is redone', { skip: !canTar }, async () => {
  const s = await scenario();
  await assembleIn(s);
  assert.equal((await readState(s.root))?.engine, 'cu121');
  s.commands.length = 0;
  s.downloads.length = 0;

  const state = await assembleIn(s, { engine: 'cpu', switchEngine: true });
  assert.equal(state.engine, 'cpu');
  assert.equal(state.complete, true);
  const torch = s.commands.filter((c) => c.includes('torch==2.5.1') && c.includes('install'));
  assert.equal(torch.length, 1);
  assert.ok(torch[0].includes('--force-reinstall') && torch[0].includes('https://idx/cpu'));
  assert.equal(s.commands.filter((c) => c.includes('einops')).length, 0); // the rest was not redone
  assert.equal(s.downloads.length, 0);
  assert.equal(state.torch_installed, '2.5.1+cpu');

  // asking for the engine already installed does nothing
  s.commands.length = 0;
  await assembleIn(s, { engine: 'cpu', switchEngine: true });
  assert.equal(s.commands.filter((c) => c.includes('install')).length, 0);
});

test("after an app update, the worker's code inside the engine is replaced (and only when the version differs)", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'singalong-refresh-'));
  const source = join(dir, 'worker');
  const root = join(dir, 'engine');
  const put = async (base: string, version: string, extra: Record<string, string> = {}) => {
    await mkdir(join(base, 'singalong_worker'), { recursive: true });
    await writeFile(join(base, 'singalong_worker', 'version.py'), `__version__ = "${version}"\n`);
    await writeFile(join(base, 'requirements.txt'), `req-${version}\n`);
    for (const [name, text] of Object.entries(extra)) await writeFile(join(base, 'singalong_worker', name), text);
  };
  await put(join(root, 'app'), '0.4.0', { 'old.py': 'left the new version' });
  await put(source, '1.2.5', { 'cloud.py': 'new' });

  assert.deepEqual(await refreshWorker({ root, workerSource: source }), { updated: true, from: '0.4.0', to: '1.2.5' });
  assert.equal(await readFile(join(root, 'app', 'singalong_worker', 'cloud.py'), 'utf8'), 'new');
  assert.equal(await readFile(join(root, 'app', 'requirements.txt'), 'utf8'), 'req-1.2.5\n');
  await assert.rejects(stat(join(root, 'app', 'singalong_worker', 'old.py')), { code: 'ENOENT' }); // what left the new version is not left behind
  assert.deepEqual(await refreshWorker({ root, workerSource: source }), { updated: false, from: '1.2.5', to: '1.2.5' }); // up to date: untouched
  assert.deepEqual(await refreshWorker({ root, workerSource: join(dir, 'missing') }), { updated: false, from: null, to: null }); // no source: does nothing
});

test("installFiles keeps relative links (Linux's bin/python3 points to python3.11, and the temporary folder is deleted afterwards)", { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'singalong-link-'));
  const extracted = join(dir, 'extracted');
  await mkdir(join(extracted, 'python', 'bin'), { recursive: true });
  await writeFile(join(extracted, 'python', 'bin', 'python3.11'), 'PY');
  await symlink('python3.11', join(extracted, 'python', 'bin', 'python3'));
  const root = join(dir, 'engine');
  await installFiles(extracted, [{ from: 'python', to: 'python' }], root);
  await rm(extracted, { recursive: true, force: true }); // as the assembler does after installing
  assert.equal(await readlink(join(root, 'python', 'bin', 'python3')), 'python3.11');
  assert.equal(await readFile(join(root, 'python', 'bin', 'python3'), 'utf8'), 'PY'); // the link still opens
});

test("AMD engine (ROCm 6.2): torch comes from the rocm6.2 index and the GPU test is AMD's", { skip: !canTar }, async () => {
  const s = await scenario({ hardware: { engine: 'rocm6.2', reason: 'AMD Radeon RX 7900 XTX (gfx1100) pelo ROCm 6.2', gpus: [{ name: 'AMD' }], cpu_cores: 16, ram_mb: 32000 } });
  const state = await assembleIn(s);
  assert.equal(state.engine, 'rocm6.2');
  assert.equal(state.complete, true);
  assert.ok(s.commands.some((c) => c.includes('torch==2.5.1') && c.includes('--index-url https://idx/rocm6.2')));
  assert.ok(s.commands.some((c) => c.includes('gpu_selftest("rocm6.2")'))); // the GPU is checked with AMD's test, not CUDA's
});

test('the AMD card fails the real test: back to the CPU, only torch is swapped and the reason is recorded', { skip: !canTar }, async () => {
  const s = await scenario({ hardware: { engine: 'rocm6.2', reason: 'AMD', gpus: [], cpu_cores: 8, ram_mb: 16000 }, selftest: { ok: false, detail: 'HIP error: invalid device function' } });
  const state = await assembleIn(s);
  assert.equal(state.engine, 'cpu');
  assert.equal(state.fallback_reason, 'HIP error: invalid device function');
  assert.equal(s.commands.filter((c) => c.includes('torch==2.5.1') && c.includes('install')).length, 2);
});

test("Apple's GPU (mps): only by choice, it uses PyTorch's cpu index (macOS's already has Metal) and the Metal test", { skip: !canTar }, async () => {
  const auto = await scenario({ hardware: { engine: 'cpu', reason: 'Mac: o automático usa a CPU', gpus: [{ name: 'Apple M2' }], cpu_cores: 8, ram_mb: 16000 } });
  assert.equal((await assembleIn(auto)).engine, 'cpu'); // automatic on a Mac is the CPU

  const chosen = await scenario({ hardware: { engine: 'cpu', reason: 'Mac', gpus: [{ name: 'Apple M2' }], cpu_cores: 8, ram_mb: 16000 } });
  const state = await assembleIn(chosen, { engine: 'mps' });
  assert.equal(state.engine, 'mps');
  assert.equal(state.engine_reason, 'escolhido: mps');
  assert.ok(chosen.commands.some((c) => c.includes('torch==2.5.1') && c.includes('--index-url https://idx/cpu')));
  assert.ok(chosen.commands.some((c) => c.includes('gpu_selftest("mps")')));
  assert.equal(state.fallback_reason, undefined);

  const broken = await scenario({ selftest: { ok: false, detail: 'NotImplementedError: aten::stft is not available on MPS' } });
  const fell = await assembleIn(broken, { engine: 'mps' });
  assert.equal(fell.engine, 'cpu'); // Metal failed the test: the CPU, with the reason
  assert.match(fell.fallback_reason ?? '', /aten::stft/);
});

test("the engines: which have a GPU and which PyTorch index each one uses", () => {
  assert.deepEqual(['cpu', 'cu121', 'rocm6.2', 'mps'].map(isAccelerated), [false, true, true, true]);
  assert.deepEqual(['cpu', 'cu121', 'rocm6.2', 'mps'].map(torchIndexFor), ['cpu', 'cu121', 'rocm6.2', 'cpu']);
});

test("the worker gets the installed engine (SINGALONG_ENGINE) and, on a Mac, the detour for the operations Metal lacks", async () => {
  const dir = await mkdtemp(join(tmpdir(), 'singalong-env-'));
  assert.deepEqual(engineEnv(dir, 'linux'), {}); // engine not assembled yet: nothing changes
  await writeFile(join(dir, 'engine.json'), JSON.stringify({ engine: 'rocm6.2', complete: true }));
  assert.deepEqual(engineEnv(dir, 'linux'), { SINGALONG_ENGINE: 'rocm6.2' });
  assert.deepEqual(engineEnv(dir, 'darwin'), { SINGALONG_ENGINE: 'rocm6.2', PYTORCH_ENABLE_MPS_FALLBACK: '1' });
  await writeFile(join(dir, 'engine.json'), 'not json');
  assert.deepEqual(engineEnv(dir, 'win32'), {}); // an unreadable file: nothing changes
  await writeFile(join(dir, 'engine.json'), JSON.stringify({ engine: 'mps' }));
  assert.equal(launchEnv(dir, {}, { PATH: '/usr/bin' }).SINGALONG_ENGINE, 'mps');
  assert.equal(launchEnv(dir, { SINGALONG_ENGINE: 'cpu' }, { PATH: '/usr/bin' }).SINGALONG_ENGINE, 'cpu'); // `extra` overrides
});
