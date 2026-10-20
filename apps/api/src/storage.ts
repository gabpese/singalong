// The local storage driver. The same contract as the worker's (docs/PLAN.md, section 14): exists / read / getUrl / list /
// delete. The rest of the code only knows logical keys ("cache/<video_id>/instrumental.mp3"). A future S3/R2 driver implements
// this same interface.
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import type { Dirent } from 'node:fs';
import { dirname, join, normalize, resolve, sep } from 'node:path';

/** Resolves `rel` inside `root`; null when it escapes the folder (path traversal). */
export function safeJoin(root: string, rel: string): string | null {
  const full = resolve(root, normalize(rel).replace(/^[/\\]+/, ''));
  return full === root || full.startsWith(root + sep) ? full : null;
}

export class LocalStorage {
  /** This driver serves the files through the API itself (the /media route). */
  readonly local = true;
  readonly root: string;

  constructor(
    root: string,
    private readonly publicBaseUrl = '',
  ) {
    this.root = resolve(root);
  }

  #path(key: string): string {
    const path = safeJoin(this.root, key);
    if (!path) throw new Error(`chave inválida: ${key}`);
    return path;
  }

  async exists(key: string): Promise<boolean> {
    try {
      return (await stat(this.#path(key))).isFile();
    } catch {
      return false;
    }
  }

  async read(key: string): Promise<Buffer> {
    return readFile(this.#path(key));
  }

  /** Writes the whole file at once: to a .tmp first, then renamed, so nobody reads half a file. */
  async write(key: string, data: Buffer | string): Promise<void> {
    const path = this.#path(key);
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
    try {
      await writeFile(temp, data);
      await rename(temp, path);
    } catch (error) {
      await unlink(temp).catch(() => {});
      throw error;
    }
  }

  getUrl(key: string): string {
    this.#path(key); // checks the key
    return `${this.publicBaseUrl}/media/${key}`;
  }

  async delete(prefix: string): Promise<void> {
    await rm(this.#path(prefix), { recursive: true, force: true });
  }

  async list(prefix = ''): Promise<string[]> {
    const base = prefix ? this.#path(prefix) : this.root;
    const out: string[] = [];
    const walk = async (dir: string) => {
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (!entry.name.endsWith('.tmp')) out.push(full.slice(this.root.length + 1).split(sep).join('/'));
      }
    };
    await walk(base);
    return out.sort();
  }

  /** Like `list`, with each file's size in bytes and its modification time (ms): the base of the cache cleaning. */
  async listDetailed(prefix = ''): Promise<{ key: string; size: number; mtimeMs: number }[]> {
    const out: { key: string; size: number; mtimeMs: number }[] = [];
    for (const key of await this.list(prefix)) {
      try {
        const info = await stat(this.#path(key));
        out.push({ key, size: info.size, mtimeMs: info.mtimeMs });
      } catch {
        // gone between the listing and the stat (another process deleted it): skip it
      }
    }
    return out;
  }

  /** Does the storage take writes? (a full disk, a read-only volume...) Throws when it does not. */
  async check(): Promise<true> {
    const probe = this.#path('.healthcheck');
    await writeFile(probe, String(Date.now()));
    await unlink(probe);
    return true;
  }

  /** The local driver's own: the absolute path, for the /media route. */
  absolutePath(key: string): string | null {
    return safeJoin(this.root, key);
  }
}
