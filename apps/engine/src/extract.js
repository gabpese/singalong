// Extração dos arquivos baixados e cópia só do que o motor precisa. No Windows 10/11 o tar.exe (bsdtar) lê .zip e .tar.gz.
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

/** O tar do sistema. No Windows usa o bsdtar do próprio Windows (System32): um `tar` do Git/MSYS no PATH leria "D:\pasta" como máquina remota. */
export function tarCommand() {
  if (process.platform !== 'win32') return 'tar';
  const system = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  return existsSync(system) ? system : 'tar';
}

export async function extract(archive, dest, { run = spawnSync } = {}) {
  await rm(dest, { recursive: true, force: true });
  await mkdir(dest, { recursive: true });
  const attempts = [[tarCommand(), ['-xf', archive, '-C', dest]]];
  if (archive.endsWith('.zip')) attempts.push(['unzip', ['-q', '-o', archive, '-d', dest]]); // tar do GNU (Linux) não lê zip
  let last;
  for (const [command, args] of attempts) {
    const done = run(command, args, { encoding: 'utf8', windowsHide: true });
    if (!done.error && done.status === 0) return;
    last = done.error?.message ?? done.stderr ?? `status ${done.status}`;
  }
  throw new Error(`Não consegui extrair ${archive}: ${String(last).trim()}`);
}

/** Resolve "*" (um nível de pasta) e devolve o caminho real, ou null se não existe. O resultado nunca sai de `base`. */
export async function resolveGlob(base, pattern) {
  let current = [base];
  for (const part of pattern.split('/')) {
    const next = [];
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
    const found = await readdir(dirname(candidate)).then((names) => names.includes(candidate.split(sep).pop())).catch(() => false);
    if (found) return candidate;
  }
  return null;
}

/** Copia os arquivos listados no manifesto (`files: [{from, to}]`) da pasta extraída para dentro do motor. */
export async function installFiles(extracted, files, root) {
  for (const { from, to } of files) {
    const source = await resolveGlob(extracted, from);
    if (!source) throw new Error(`O pacote baixado não tem ${from}`);
    const target = resolve(root, to);
    if (!target.startsWith(resolve(root) + sep)) throw new Error(`Destino fora do motor: ${to}`);
    await rm(target, { recursive: true, force: true });
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { recursive: true });
  }
}
