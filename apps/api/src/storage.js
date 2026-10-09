// Driver de storage local. Mesmo contrato do worker (PLANO.md, seção 14):
// exists / read / getUrl / list / delete. O resto do código só conhece chaves lógicas
// ("cache/<video_id>/instrumental.mp3"). O driver S3/R2 futuro implementa esta mesma interface.
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import { join, normalize, resolve, sep } from 'node:path';

/** Resolve `rel` dentro de `root`; null se escapar da pasta (path traversal). */
export function safeJoin(root, rel) {
  const full = resolve(root, normalize(rel).replace(/^[/\\]+/, ''));
  return full === root || full.startsWith(root + sep) ? full : null;
}

export class LocalStorage {
  /** Este driver serve os arquivos pela própria API (rota /media). */
  local = true;

  constructor(root, publicBaseUrl = '') {
    this.root = resolve(root);
    this.publicBaseUrl = publicBaseUrl;
  }

  #path(key) {
    const path = safeJoin(this.root, key);
    if (!path) throw new Error(`chave inválida: ${key}`);
    return path;
  }

  async exists(key) {
    try {
      return (await stat(this.#path(key))).isFile();
    } catch {
      return false;
    }
  }

  async read(key) {
    return readFile(this.#path(key));
  }

  getUrl(key) {
    this.#path(key); // valida a chave
    return `${this.publicBaseUrl}/media/${key}`;
  }

  async delete(prefix) {
    await rm(this.#path(prefix), { recursive: true, force: true });
  }

  async list(prefix = '') {
    const base = prefix ? this.#path(prefix) : this.root;
    const out = [];
    const walk = async (dir) => {
      let entries;
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

  /** Específico do driver local: caminho absoluto, para a rota /media. */
  absolutePath(key) {
    return safeJoin(this.root, key);
  }
}
