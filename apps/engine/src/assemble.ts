// Assembles the engine on the user's computer from the official sources (manifest.json): Python, ffmpeg, deno and the pip
// packages. Each step done is recorded in engine.json: if the app closes halfway, the next run carries on where it stopped.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { download } from './download.ts';
import { type EnginePaths, type EngineState, launchEnv, paths, readState, writeState } from './engine.ts';
import { extract, installFiles } from './extract.ts';

const here = fileURLToPath(new URL('.', import.meta.url));
export const DEFAULT_MANIFEST = join(here, '..', 'manifest.json');
export const DEFAULT_WORKER_SOURCE = join(here, '..', '..', 'worker');

export const thisPlatform = () => `${process.platform}-${process.arch}`;

/** A component downloaded from its official source, and the files of it the engine keeps. */
interface Component {
  version: string;
  url: string;
  sha256: string;
  files: { from: string; to: string }[];
}

/** A pip step: a requirements file, packages with their arguments, or the torch from PyTorch's own index. */
interface PipStep {
  name: string;
  requirements?: boolean;
  args?: string[];
  torchIndex?: boolean;
}

/** manifest.json as it is on disk: the components per system, plus what holds for all of them. */
interface RawManifest {
  pack_version: string;
  comment?: string;
  platforms?: Record<string, { components: Record<string, Component> }>;
  torch: { version: string; index: string };
  pip: PipStep[];
}

/** The manifest for one system. */
export type Manifest = Omit<RawManifest, 'platforms'> & { platform: string; components: Record<string, Component> };

/** What a progress report carries: the step, what to show, and how far a download or an installation went. */
export interface Progress {
  step: string;
  label: string;
  done?: number;
  total?: number;
  line?: string;
}

/**
 * The manifest resolved for one system: the components (Python, ffmpeg, deno) are the `platform`'s; torch and pip hold for
 * all. The keys keep their usual order (the hash of the Windows manifest must not change: it would rebuild the engine of
 * everyone who already assembled it).
 */
export const resolveManifest = (raw: RawManifest, platform = thisPlatform()): Manifest => {
  const entry = raw.platforms?.[platform];
  if (!entry) throw new Error(`Não há motor para este computador (${platform}). Sistemas com motor: ${Object.keys(raw.platforms ?? {}).join(', ')}.`);
  return { pack_version: raw.pack_version, platform, comment: raw.comment, components: entry.components, torch: raw.torch, pip: raw.pip };
};

export const loadManifest = async (file = DEFAULT_MANIFEST, platform = thisPlatform()) => resolveManifest(JSON.parse(await readFile(file, 'utf8')), platform);

/** Identifies a version of the manifest: when it changes (a new component), the affected steps are done again. */
export const manifestHash = (manifest: Manifest) => createHash('sha256').update(JSON.stringify(manifest)).digest('hex').slice(0, 16);

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  onLine?: (line: string) => void;
  spawnImpl?: typeof spawn;
}

/** Runs a program and gathers its output; throws with the output's end when it fails. */
export function run(command: string, args: string[], { cwd, env, onLine = () => {}, spawnImpl = spawn }: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, { cwd, env, windowsHide: true });
    let output = '';
    const feed = (data: Buffer) => {
      const text = data.toString();
      output += text;
      for (const line of text.split(/\r?\n/)) if (line.trim()) onLine(line.trim());
    };
    child.stdout?.on('data', feed);
    child.stderr?.on('data', feed);
    child.on('error', (error) => reject(new Error(`Não consegui executar ${basename(command)}: ${error.message}`)));
    child.on('close', (code) => (code === 0 ? resolve(output) : reject(new Error(`${basename(command)} terminou com erro ${code}:\n${output.slice(-1500)}`))));
  });
}

function pythonJson<T>(root: string, code: string, runImpl = run): Promise<T> {
  const p = paths(root);
  return runImpl(p.python, ['-I', '-c', code], { cwd: p.root, env: launchEnv(root) }).then((out) => JSON.parse(out.trim().split(/\r?\n/).pop()!));
}

/** What the hardware check (the worker's own code, standard library only) recommends for this computer. */
export function probeHardware(root: string, { forceCpu = false, runImpl = run } = {}) {
  const app = JSON.stringify(paths(root).app);
  return pythonJson<{ engine: string; reason: string; gpus: unknown; cpu_cores: number; ram_mb: number }>(
    root,
    `import json,sys;sys.path.insert(0,${app});from singalong_worker import hardware;print(json.dumps(hardware.probe(force_cpu=${forceCpu ? 'True' : 'False'})))`,
    runImpl,
  );
}

/** The engines with a GPU: NVIDIA (CUDA 12.1), AMD (ROCm 6.2, Linux only) and Apple (Metal, Mac only, optional). The other is the CPU. */
export const ACCELERATED_ENGINES = ['cu121', 'rocm6.2', 'mps'];
export const ENGINES = ['cpu', ...ACCELERATED_ENGINES];
export const isAccelerated = (engine: string | undefined) => ACCELERATED_ENGINES.includes(engine ?? '');

/** Each engine's PyTorch index. The Mac's uses the `cpu` index (which on macOS has the arm64 packages with Metal included). */
export const torchIndexFor = (engine: string) => (engine === 'mps' ? 'cpu' : engine);

/** The real GPU test, inside the installed engine. */
export function gpuSelftest(root: string, { runImpl = run, engine = 'cu121' } = {}) {
  const app = JSON.stringify(paths(root).app);
  return pythonJson<{ ok: boolean; detail: string }>(
    root,
    `import json,sys;sys.path.insert(0,${app});from singalong_worker import hardware;print(json.dumps(hardware.gpu_selftest(${JSON.stringify(engine)})))`,
    runImpl,
  );
}

/** Copies the worker's code into the engine (the previous copy goes: files the new version dropped do not stay behind). */
async function copyWorker(p: EnginePaths, workerSource: string) {
  await rm(p.app, { recursive: true, force: true });
  await mkdir(p.app, { recursive: true });
  await cp(join(workerSource, 'singalong_worker'), join(p.app, 'singalong_worker'), {
    recursive: true,
    filter: (source) => !/__pycache__|\.pyc$/.test(source),
  });
  await cp(join(workerSource, 'requirements.txt'), join(p.app, 'requirements.txt'));
}

const versionOf = async (dir: string) => /__version__\s*=\s*["']([^"']+)["']/.exec(await readFile(join(dir, 'singalong_worker', 'version.py'), 'utf8').catch(() => ''))?.[1] ?? null;

/**
 * The app updates itself, but the worker's code inside the engine used to be copied only at assembly: after an update the
 * computer kept the old worker (and the server saw it as a version too old). This swaps the copy when the version differs.
 * Returns `{ updated, from, to }`; without an assembled engine or a source it does nothing.
 */
export async function refreshWorker({ root, workerSource = DEFAULT_WORKER_SOURCE }: { root: string; workerSource?: string }) {
  const p = paths(root);
  const to = await versionOf(workerSource);
  if (!to) return { updated: false, from: null, to: null };
  const from = await versionOf(p.app);
  if (from === to) return { updated: false, from, to };
  await copyWorker(p, workerSource);
  return { updated: true, from, to };
}

export interface AssembleOptions {
  root: string;
  manifest?: Manifest;
  /** "auto" (decided by the hardware), "cpu", "cu121" (NVIDIA), "rocm6.2" (AMD, Linux) or "mps" (Apple's GPU, Mac). */
  engine?: string;
  /** With the engine already assembled, switches to the `engine` asked (only the torch is installed again: the rest stays). */
  switchEngine?: boolean;
  /** The apps/worker folder (singalong_worker + requirements.txt) that goes along in the installer. */
  workerSource?: string;
  /** Feeds the installer's progress bar. */
  onProgress?: (progress: Progress) => void;
  runImpl?: typeof run;
  fetchImpl?: typeof fetch;
  retryWait?: number;
}

/** Assembles (or finishes) the engine in `root`. Returns the final state (engine.json). */
export async function assemble({ root, manifest, engine = 'auto', switchEngine = false, workerSource = DEFAULT_WORKER_SOURCE, onProgress = () => {}, runImpl = run, fetchImpl = fetch, retryWait }: AssembleOptions): Promise<EngineState> {
  const plan = manifest ?? (await loadManifest());
  if (thisPlatform() !== plan.platform && !process.env.SINGALONG_ENGINE_ANY_PLATFORM) {
    throw new Error(`Este motor é para ${plan.platform}; este computador é ${thisPlatform()}.`);
  }
  const p = paths(root);
  await mkdir(p.downloads, { recursive: true });
  const hash = manifestHash(plan);
  let state: EngineState = (await readState(root)) ?? { steps: {}, components: {} };
  if (state.manifest !== hash) state = { manifest: hash, pack_version: plan.pack_version, steps: {}, components: {} };
  const save = (patch: Partial<EngineState>) => writeState(root, (state = { ...state, ...patch }));
  const done = async (step: string) => save({ steps: { ...state.steps, [step]: true } });
  const progress = (step: string, label: string, extra: Partial<Progress> = {}) => onProgress({ step, label, ...extra });

  // 1) the components downloaded from their official sources, in order: Python first (the hardware check uses it)
  for (const [name, component] of Object.entries(plan.components)) {
    const step = `component:${name}`;
    if (state.steps[step]) continue;
    progress(step, `Baixando ${name} ${component.version}`);
    const archive = join(p.downloads, decodeURIComponent(basename(new URL(component.url).pathname)));
    await download({ url: component.url, dest: archive, sha256: component.sha256, fetchImpl, retryWait, onProgress: ({ done: d, total }) => progress(step, `Baixando ${name}`, { done: d, total }) });
    progress(step, `Instalando ${name}`);
    const tmp = join(p.downloads, `extraido-${name}`);
    await extract(archive, tmp, { python: p.python });
    await installFiles(tmp, component.files, root);
    await rm(tmp, { recursive: true, force: true });
    await save({ components: { ...state.components, [name]: { version: component.version, sha256: component.sha256 } } });
    await done(step);
  }

  // 2) the worker's code (it goes along in the installer) and its requirements
  if (!state.steps.worker) {
    progress('worker', 'Copiando o aplicativo');
    await copyWorker(p, workerSource);
    await done('worker');
  }

  // 3) chooses the engine by the hardware (unless the user or the installer forced one)
  if (!state.engine) {
    progress('hardware', 'Verificando o computador');
    const probe = await probeHardware(root, { forceCpu: engine === 'cpu', runImpl });
    const chosen = ENGINES.includes(engine) ? engine : probe.engine;
    await save({ engine: chosen, engine_reason: engine === 'auto' ? probe.reason : `escolhido: ${engine}`, hardware: { gpus: probe.gpus, cpu_cores: probe.cpu_cores, ram_mb: probe.ram_mb } });
  }

  // 3b) the user asked for another engine (settings): only torch/torchvision and the GPU test are done again
  let switching = false;
  if (switchEngine && state.engine) {
    progress('hardware', 'Verificando o computador');
    const probe = await probeHardware(root, { forceCpu: engine === 'cpu', runImpl });
    const target = engine === 'auto' ? probe.engine : engine;
    if (target !== state.engine) {
      switching = true;
      const steps: Record<string, boolean> = { ...state.steps, selftest: false };
      plan.pip.forEach((step, i) => {
        if (step.torchIndex) steps[`pip:${i}`] = false;
      });
      await save({ engine: target, engine_reason: engine === 'auto' ? probe.reason : `escolhido: ${engine}`, fallback_reason: undefined, complete: false, steps });
    }
  }

  // 4) the pip packages (torch from PyTorch's official index: cpu, cu121 or rocm6.2; on a Mac, the cpu one)
  await installPip({ root, manifest: plan, state: () => state, save, done, progress, runImpl, engine: state.engine!, force: switching });

  // 5) the real GPU test; when it fails, the torch is swapped for the CPU one and the reason is recorded
  if (isAccelerated(state.engine) && !state.steps.selftest) {
    progress('selftest', 'Testando a placa de vídeo');
    const result = await gpuSelftest(root, { runImpl, engine: state.engine });
    if (!result.ok) {
      progress('selftest', 'A placa não funcionou: usando a CPU');
      await save({ fallback_reason: result.detail, engine: 'cpu' });
      await installPip({ root, manifest: plan, state: () => state, save, done, progress, runImpl, engine: 'cpu', force: true });
    }
    await done('selftest');
  } else if (state.engine === 'cpu' && !state.steps.selftest) {
    await done('selftest');
  }

  await save({ complete: true, completed_at: new Date().toISOString() });
  progress('done', 'Motor pronto');
  return state;
}

async function installPip({
  root,
  manifest,
  state,
  save,
  done,
  progress,
  runImpl,
  engine,
  force = false,
}: {
  root: string;
  manifest: Manifest;
  /** The state as it is now (each step done replaces it). */
  state: () => EngineState;
  save: (patch: Partial<EngineState>) => Promise<void>;
  done: (step: string) => Promise<void>;
  progress: (step: string, label: string, extra?: Partial<Progress>) => void;
  runImpl: typeof run;
  engine: string;
  force?: boolean;
}) {
  const p = paths(root);
  const index = manifest.torch.index.replace('{engine}', torchIndexFor(engine));
  for (const [i, step] of manifest.pip.entries()) {
    const key = `pip:${i}`;
    if (state().steps[key] && !(force && step.torchIndex)) continue; // on the way back to the CPU, only torch/torchvision are swapped
    progress(key, `Instalando ${step.name}`);
    const args = ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-warn-script-location'];
    if (force && step.torchIndex) args.push('--force-reinstall', '--no-deps');
    if (step.requirements) args.push('-r', join(p.app, 'requirements.txt'));
    args.push(...(step.args ?? []));
    if (step.torchIndex) args.push('--index-url', index);
    await runImpl(p.python, args, { cwd: p.root, env: launchEnv(root), onLine: (line) => progress(key, `Instalando ${step.name}`, { line }) });
    await done(key);
  }
  // the Dockerfile's last check: nothing may have changed the torch version (Demucs breaks with another)
  const wanted = manifest.torch.version;
  const out = await runImpl(p.python, ['-I', '-c', 'import torch;print(torch.__version__)'], { cwd: root, env: launchEnv(root) });
  if (!out.trim().split(/\r?\n/).pop()!.startsWith(wanted)) throw new Error(`O torch instalado não é o ${wanted}: ${out.trim()}`);
  await save({ torch_installed: out.trim().split(/\r?\n/).pop() });
}
