// Extracts the downloaded files and copies only what the engine needs. On Windows 10/11, tar.exe (bsdtar) reads .zip and .tar.gz.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, cp, mkdir, readdir, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

/** The system's tar. On Windows it is Windows's own bsdtar (System32): a Git/MSYS `tar` on the PATH would read "D:\folder" as a remote host. */
export function tarCommand(): string {
  if (process.platform !== 'win32') return 'tar';
  const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  return existsSync(system) ? system : 'tar';
}

/**
 * `python`: the engine's own Python (already installed: it is the first component) is the fallback on a lean Linux, where GNU
 * tar does not read .zip and `unzip` and `xz` may be missing (Linux's ffmpeg comes as .tar.xz).
 */
export async function extract(archive: string, dest: string, { run = spawnSync, python = null }: { run?: typeof spawnSync; python?: string | null } = {}): Promise<void> {
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  const attempts: [string, string[]][] = [[tarCommand(), ['-xf', archive, '-C', dest]]];
  if (archive.endsWith('.zip')) attempts.push(['unzip', ['-q', '-o', archive, '-d', dest]]); // GNU tar (Linux) does not read zip
  if (python && existsSync(python)) attempts.push([python, ['-m', archive.endsWith('.zip') ? 'zipfile' : 'tarfile', '-e', archive, dest]]);
  let last: unknown;
  for (const [command, args] of attempts) {
    const done = run(command, args, { encoding: 'utf8', windowsHide: true });
    if (!done.error && done.status === 0) return;
    last = done.error?.message ?? done.stderr ?? `status ${done.status}`;
  }
  throw new Error(`Não consegui extrair ${archive}: ${String(last).trim()}`);
}

/** Resolves "*" (one folder level) and returns the real path, or null when it does not exist. The result never leaves `base`. */
export async function resolveGlob(base: string, pattern: string): Promise<string | null> {
  let current = [base];
  for (const part of pattern.split('/')) {
    const next: string[] = [];
    for (const dir of current) {
      if (part === '*') {
        const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
        next.push(...entries.filter((entry) => entry.isDirectory()).map((entry) => join(dir, entry.name)));
      } else {
        next.push(join(dir, part));
      }
    }
    current = next;
  }
  const root = resolve(base) + sep;
  for (const candidate of current) {
    if (!resolve(candidate).startsWith(root)) continue;
    const found = await readdir(dirname(candidate)).then((names) => names.includes(candidate.split(sep).pop()!)).catch(() => false);
    if (found) return candidate;
  }
  return null;
}

/** Copies the files the manifest lists (`files: [{from, to}]`) from the extracted folder into the engine. */
export async function installFiles(extracted: string, files: { from: string; to: string }[], root: string): Promise<void> {
  for (const { from, to } of files) {
    const source = await resolveGlob(extracted, from);
    if (!source) throw new Error(`O pacote baixado não tem ${from}`);
    const target = resolve(root, to);
    if (!target.startsWith(resolve(root) + sep)) throw new Error(`Destino fora do motor: ${to}`);
    await rm(target, { recursive: true, force: true });
    await mkdir(dirname(target), { recursive: true });
    // Linux's Python has bin/python3 -> python3.11: the link must stay relative, not point to the temporary folder
    await cp(source, target, { recursive: true, verbatimSymlinks: true });
    if (process.platform !== 'win32' && /^bin\//.test(to)) await chmod(target, 0o755); // a zip opened by Python does not keep the execute bit
  }
}
