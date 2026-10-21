// The installed engine's layout and how the app runs it. The engine lives in a folder of its own (by default
// %LOCALAPPDATA%\Singalong\engine).
import { readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';

export const STATE_FILE = 'engine.json';

/** What engine.json records: the steps done, the components installed and the engine chosen. */
export interface EngineState {
  manifest?: string;
  pack_version?: string;
  steps: Record<string, boolean>;
  components: Record<string, { version: string; sha256: string }>;
  engine?: string;
  engine_reason?: string;
  fallback_reason?: string;
  hardware?: { gpus: unknown; cpu_cores: number; ram_mb: number };
  torch_installed?: string;
  complete?: boolean;
  completed_at?: string;
}

export const paths = (root: string) => ({
  root,
  python: join(root, 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3'),
  pythonDir: join(root, 'python'),
  bin: join(root, 'bin'),
  app: join(root, 'app'),
  downloads: join(root, 'downloads'),
  models: join(root, 'models'),
  state: join(root, STATE_FILE),
});

export type EnginePaths = ReturnType<typeof paths>;

export async function readState(root: string): Promise<EngineState | null> {
  try {
    return JSON.parse(await readFile(paths(root).state, 'utf8'));
  } catch {
    return null;
  }
}

export async function writeState(root: string, state: EngineState): Promise<void> {
  await mkdir(root, { recursive: true });
  await writeFile(paths(root).state, JSON.stringify(state, null, 2));
}

/**
 * What the installed engine asks of the worker: which engine it is (SINGALONG_ENGINE, which decides each AI step's device)
 * and, on a Mac, that the operations Metal still lacks fall back to the CPU instead of failing. It reads engine.json (without
 * it, nothing changes).
 */
export function engineEnv(root: string, platform: string = process.platform): Record<string, string> {
  let engine: string | null = null;
  try {
    engine = JSON.parse(readFileSync(paths(root).state, 'utf8')).engine ?? null;
  } catch {
    /* the engine is not assembled yet */
  }
  return {
    ...(engine ? { SINGALONG_ENGINE: engine } : {}),
    ...(platform === 'darwin' ? { PYTORCH_ENABLE_MPS_FALLBACK: '1' } : {}),
  };
}

/**
 * The worker process's environment: ffmpeg and deno sit in a folder of the engine's own, which goes into the PATH of THIS
 * process only (the user's computer is not changed, and an ffmpeg they already have is not used). `extra` overrides
 * (AGENT_URL, etc.).
 */
export function launchEnv(root: string, extra: Record<string, string> = {}, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
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

/** [executable, arguments, options] to start the engine's worker or agent. */
export function workerCommand(root: string, args: string[] = [], extraEnv: Record<string, string> = {}) {
  const p = paths(root);
  return [p.python, ['-m', 'singalong_worker', ...args], { cwd: p.app, env: launchEnv(root, extraEnv), windowsHide: true }] as const;
}
