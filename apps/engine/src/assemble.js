// Monta o motor no computador do usuário a partir das fontes oficiais (manifest.json): Python, ffmpeg, deno e os pacotes pip.
// Cada etapa concluída fica registrada em engine.json: se o app fechar no meio, a próxima execução continua de onde parou.
import { spawn } from 'node:child_process';
import { cp, mkdir, readFile, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { download } from './download.js';
import { extract, installFiles } from './extract.js';
import { launchEnv, paths, readState, writeState } from './engine.js';

const here = fileURLToPath(new URL('.', import.meta.url));
export const DEFAULT_MANIFEST = join(here, '..', 'manifest.json');
export const DEFAULT_WORKER_SOURCE = join(here, '..', '..', 'worker');

export const thisPlatform = () => `${process.platform}-${process.arch}`;

/**
 * O manifesto resolvido para um sistema: os componentes (Python, ffmpeg, deno) são os do `platform`; torch e pip valem para todos.
 * A ordem das chaves é a de sempre (o hash do manifesto do Windows não pode mudar: mudaria e refaria o motor de quem já o montou).
 */
export const resolveManifest = (raw, platform = thisPlatform()) => {
  const entry = raw.platforms?.[platform];
  if (!entry) throw new Error(`Não há motor para este computador (${platform}). Sistemas com motor: ${Object.keys(raw.platforms ?? {}).join(', ')}.`);
  return { pack_version: raw.pack_version, platform, comment: raw.comment, components: entry.components, torch: raw.torch, pip: raw.pip };
};

export const loadManifest = async (file = DEFAULT_MANIFEST, platform = thisPlatform()) => resolveManifest(JSON.parse(await readFile(file, 'utf8')), platform);

/** Identifica uma versão do manifesto: se mudar (um componente novo), as etapas afetadas são refeitas. */
export const manifestHash = (manifest) => createHash('sha256').update(JSON.stringify(manifest)).digest('hex').slice(0, 16);

/** Roda um programa e junta a saída; levanta erro com o final da saída se falhar. */
export function run(command, args, { cwd, env, onLine = () => {}, spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command, args, { cwd, env, windowsHide: true });
    let output = '';
    const feed = (data) => {
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

function pythonJson(root, code, runImpl = run) {
  const p = paths(root);
  return runImpl(p.python, ['-I', '-c', code], { cwd: p.root, env: launchEnv(root) }).then((out) => JSON.parse(out.trim().split(/\r?\n/).pop()));
}

/** O que a verificação de hardware (o mesmo código do worker, só biblioteca padrão) recomenda para este computador. */
export function probeHardware(root, { forceCpu = false, runImpl = run } = {}) {
  const app = JSON.stringify(paths(root).app);
  return pythonJson(root, `import json,sys;sys.path.insert(0,${app});from singalong_worker import hardware;print(json.dumps(hardware.probe(force_cpu=${forceCpu ? 'True' : 'False'})))`, runImpl);
}

/** Os motores com GPU: NVIDIA (CUDA 12.1), AMD (ROCm 6.2, só Linux) e Apple (Metal, só Mac, opcional). O outro é a CPU. */
export const ACCELERATED_ENGINES = ['cu121', 'rocm6.2', 'mps'];
export const ENGINES = ['cpu', ...ACCELERATED_ENGINES];
export const isAccelerated = (engine) => ACCELERATED_ENGINES.includes(engine);

/** O índice do PyTorch de cada motor. O do Mac usa o índice `cpu` (que no macOS tem os pacotes arm64 com Metal incluído). */
export const torchIndexFor = (engine) => (engine === 'mps' ? 'cpu' : engine);

/** O teste de verdade da GPU, dentro do motor já instalado. */
export function gpuSelftest(root, { runImpl = run, engine = 'cu121' } = {}) {
  const app = JSON.stringify(paths(root).app);
  return pythonJson(root, `import json,sys;sys.path.insert(0,${app});from singalong_worker import hardware;print(json.dumps(hardware.gpu_selftest(${JSON.stringify(engine)})))`, runImpl);
}

/** Copia o código do worker para dentro do motor (apaga a cópia anterior: arquivos que saíram da versão nova não ficam para trás). */
async function copyWorker(p, workerSource) {
  await rm(p.app, { recursive: true, force: true });
  await mkdir(p.app, { recursive: true });
  await cp(join(workerSource, 'singalong_worker'), join(p.app, 'singalong_worker'), {
    recursive: true,
    filter: (source) => !/__pycache__|\.pyc$/.test(source),
  });
  await cp(join(workerSource, 'requirements.txt'), join(p.app, 'requirements.txt'));
}

const versionOf = async (dir) => (/__version__\s*=\s*["']([^"']+)["']/.exec(await readFile(join(dir, 'singalong_worker', 'version.py'), 'utf8').catch(() => ''))?.[1] ?? null);

/**
 * O app se atualiza sozinho, mas o código do worker dentro do motor só era copiado na montagem: depois de uma atualização o
 * computador continuava com o worker antigo (e o servidor o via como uma versão velha demais). Troca a cópia quando a versão difere.
 * Devolve `{ updated, from, to }`; sem motor montado ou sem fonte não faz nada.
 */
export async function refreshWorker({ root, workerSource = DEFAULT_WORKER_SOURCE }) {
  const p = paths(root);
  const to = await versionOf(workerSource);
  if (!to) return { updated: false, from: null, to: null };
  const from = await versionOf(p.app);
  if (from === to) return { updated: false, from, to };
  await copyWorker(p, workerSource);
  return { updated: true, from, to };
}

/**
 * Monta (ou conclui) o motor em `root`.
 *  engine: "auto" (decide pelo hardware), "cpu", "cu121" (NVIDIA), "rocm6.2" (AMD, Linux) ou "mps" (GPU da Apple, Mac).
 *  switchEngine: com o motor já montado, troca para o `engine` pedido (só o torch é reinstalado: o resto fica como está).
 *  workerSource: pasta apps/worker (singalong_worker + requirements.txt) que vai junto no instalador.
 *  onProgress({ step, label, done, total, line }) alimenta a barra de progresso do instalador.
 * Devolve o estado final (engine.json).
 */
export async function assemble({ root, manifest, engine = 'auto', switchEngine = false, workerSource = DEFAULT_WORKER_SOURCE, onProgress = () => {}, runImpl = run, fetchImpl = fetch, retryWait }) {
  manifest ??= await loadManifest();
  if (thisPlatform() !== manifest.platform && !process.env.SINGALONG_ENGINE_ANY_PLATFORM) {
    throw new Error(`Este motor é para ${manifest.platform}; este computador é ${thisPlatform()}.`);
  }
  const p = paths(root);
  await mkdir(p.downloads, { recursive: true });
  const hash = manifestHash(manifest);
  let state = (await readState(root)) ?? {};
  if (state.manifest !== hash) state = { manifest: hash, pack_version: manifest.pack_version, steps: {}, components: {} };
  const save = (patch) => writeState(root, (state = { ...state, ...patch }));
  const done = async (step) => save({ steps: { ...state.steps, [step]: true } });
  const progress = (step, label, extra = {}) => onProgress({ step, label, ...extra });

  // 1) componentes baixados das fontes oficiais, em ordem: o Python primeiro (a verificação de hardware usa ele)
  for (const [name, component] of Object.entries(manifest.components)) {
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

  // 2) o código do worker (vai junto no instalador) e os requisitos
  if (!state.steps.worker) {
    progress('worker', 'Copiando o aplicativo');
    await copyWorker(p, workerSource);
    await done('worker');
  }

  // 3) escolhe o motor pelo hardware (a menos que o usuário/instalador tenha forçado um)
  if (!state.engine) {
    progress('hardware', 'Verificando o computador');
    const probe = await probeHardware(root, { forceCpu: engine === 'cpu', runImpl });
    const chosen = ENGINES.includes(engine) ? engine : probe.engine;
    await save({ engine: chosen, engine_reason: engine === 'auto' ? probe.reason : `escolhido: ${engine}`, hardware: { gpus: probe.gpus, cpu_cores: probe.cpu_cores, ram_mb: probe.ram_mb } });
  }

  // 3b) o usuário pediu outro motor (configurações): só o torch/torchvision e o teste da GPU são refeitos
  let switching = false;
  if (switchEngine && state.engine) {
    progress('hardware', 'Verificando o computador');
    const probe = await probeHardware(root, { forceCpu: engine === 'cpu', runImpl });
    const target = engine === 'auto' ? probe.engine : engine;
    if (target !== state.engine) {
      switching = true;
      const steps = { ...state.steps, selftest: false };
      manifest.pip.forEach((step, i) => { if (step.torchIndex) steps[`pip:${i}`] = false; });
      await save({ engine: target, engine_reason: engine === 'auto' ? probe.reason : `escolhido: ${engine}`, fallback_reason: undefined, complete: false, steps });
    }
  }

  // 4) pacotes pip (torch pelo índice oficial do PyTorch: cpu, cu121 ou rocm6.2; no Mac, o do cpu)
  await installPip({ root, manifest, state, save, done, progress, runImpl, engine: state.engine, force: switching });

  // 5) o teste real da GPU; se falhar, troca o torch para a versão de CPU e registra o motivo
  if (isAccelerated(state.engine) && !state.steps.selftest) {
    progress('selftest', 'Testando a placa de vídeo');
    const result = await gpuSelftest(root, { runImpl, engine: state.engine });
    if (!result.ok) {
      progress('selftest', 'A placa não funcionou: usando a CPU');
      await save({ fallback_reason: result.detail, engine: 'cpu' });
      await installPip({ root, manifest, state, save, done, progress, runImpl, engine: 'cpu', force: true });
    }
    await done('selftest');
  } else if (state.engine === 'cpu' && !state.steps.selftest) {
    await done('selftest');
  }

  await save({ complete: true, completed_at: new Date().toISOString() });
  progress('done', 'Motor pronto');
  return state;
}

async function installPip({ root, manifest, state, save, done, progress, runImpl, engine, force = false }) {
  const p = paths(root);
  const index = manifest.torch.index.replace('{engine}', torchIndexFor(engine));
  for (const [i, step] of manifest.pip.entries()) {
    const key = `pip:${i}`;
    if (state.steps[key] && !(force && step.torchIndex)) continue; // no retorno para CPU só o torch/torchvision é trocado
    progress(key, `Instalando ${step.name}`);
    const args = ['-m', 'pip', 'install', '--disable-pip-version-check', '--no-warn-script-location'];
    if (force && step.torchIndex) args.push('--force-reinstall', '--no-deps');
    if (step.requirements) args.push('-r', join(p.app, 'requirements.txt'));
    args.push(...(step.args ?? []));
    if (step.torchIndex) args.push('--index-url', index);
    await runImpl(p.python, args, { cwd: p.root, env: launchEnv(root), onLine: (line) => progress(key, `Instalando ${step.name}`, { line }) });
    await done(key);
  }
  // a última verificação do Dockerfile: nada pode ter trocado a versão do torch (o Demucs quebra com outra)
  const wanted = manifest.torch.version;
  const out = await runImpl(p.python, ['-I', '-c', 'import torch;print(torch.__version__)'], { cwd: root, env: launchEnv(root) });
  if (!out.trim().split(/\r?\n/).pop().startsWith(wanted)) throw new Error(`O torch instalado não é o ${wanted}: ${out.trim()}`);
  await save({ torch_installed: out.trim().split(/\r?\n/).pop() });
}
