// Layout do motor instalado e como o app o executa. O motor vive numa pasta própria (por padrão em %LOCALAPPDATA%\Singalong\engine).
import { readFileSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

export const STATE_FILE = 'engine.json';

export const paths = (root) => ({
  root,
  python: join(root, 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3'),
  pythonDir: join(root, 'python'),
  bin: join(root, 'bin'),
  app: join(root, 'app'),
  downloads: join(root, 'downloads'),
  models: join(root, 'models'),
  state: join(root, STATE_FILE),
});

export async function readState(root) {
  try {
    return JSON.parse(await readFile(paths(root).state, 'utf8'));
  } catch {
    return null;
  }
}

export async function writeState(root, state) {
  await mkdir(root, { recursive: true });
  await writeFile(paths(root).state, JSON.stringify(state, null, 2));
}

/**
 * O que o motor instalado pede ao worker: qual é o motor (SINGALONG_ENGINE, que decide o dispositivo de cada etapa da IA) e, no Mac,
 * que as operações que o Metal ainda não tem caiam para a CPU em vez de falhar. Lê o engine.json (sem ele, nada muda).
 */
export function engineEnv(root, platform = process.platform) {
  let engine = null;
  try {
    engine = JSON.parse(readFileSync(paths(root).state, 'utf8')).engine ?? null;
  } catch {
    /* motor ainda não montado */
  }
  return {
    ...(engine ? { SINGALONG_ENGINE: engine } : {}),
    ...(platform === 'darwin' ? { PYTORCH_ENABLE_MPS_FALLBACK: '1' } : {}),
  };
}

/**
 * O ambiente do processo do worker: o ffmpeg e o deno ficam numa pasta só do motor, que entra no PATH apenas DESTE processo
 * (o computador do usuário não é alterado e um ffmpeg que ele já tenha não é usado). `extra` sobrescreve (AGENT_URL, etc.).
 */
export function launchEnv(root, extra = {}, base = process.env) {
  const p = paths(root);
  return {
    ...base,
    ...engineEnv(root),
    PATH: [p.bin, p.pythonDir, join(p.pythonDir, 'Scripts'), join(p.pythonDir, 'bin'), base.PATH ?? base.Path ?? ''].join(delimiter),
    PYTHONPATH: p.app,
    PYTHONNOUSERSITE: '1',
    PYTHONUNBUFFERED: '1',
    PYTHONUTF8: '1',
    TORCH_HOME: p.models,
    WHISPER_CACHE: join(p.models, 'whisper'),
    ...extra,
  };
}

/** [executável, argumentos, opções] para iniciar o worker/agente do motor. */
export function workerCommand(root, args = [], extraEnv = {}) {
  const p = paths(root);
  return [p.python, ['-m', 'singalong_worker', ...args], { cwd: p.app, env: launchEnv(root, extraEnv), windowsHide: true }];
}
