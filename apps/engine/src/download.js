// Download com retomada e conferência de SHA-256. Um arquivo só vale depois de o hash bater com o do manifesto.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';

export class ChecksumError extends Error {
  constructor(file, expected, actual) {
    super(`O arquivo baixado não confere (esperado ${expected.slice(0, 12)}…, veio ${actual.slice(0, 12)}…): ${file}`);
    this.code = 'checksum';
  }
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

const sizeOf = async (path) => (await stat(path).catch(() => null))?.size ?? 0;

/**
 * Baixa `url` para `dest`. Se `dest` já existe e confere, não baixa de novo. O que foi baixado fica em `dest.part`, então uma
 * queda de rede (ou fechar o app) retoma de onde parou com `Range`. Devolve { path, cached }.
 */
export async function download({ url, dest, sha256, onProgress = () => {}, fetchImpl = fetch, retries = 4, retryWait = 1000 }) {
  const expected = String(sha256).toLowerCase();
  await mkdir(dirname(dest), { recursive: true });
  if ((await sizeOf(dest)) > 0 && (await sha256File(dest)) === expected) return { path: dest, cached: true };

  const part = `${dest}.part`;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, retryWait * attempt));
    try {
      let have = await sizeOf(part);
      const response = await fetchImpl(url, { headers: have > 0 ? { Range: `bytes=${have}-` } : {}, redirect: 'follow' });
      if (response.status === 416) { // o que temos já é o arquivo inteiro (ou lixo): confere abaixo
        have = await sizeOf(part);
      } else if (response.status === 206) {
        await pipeline(response.body, progressCounter(have, response, onProgress), createWriteStream(part, { flags: 'a' }));
      } else if (response.ok) { // o servidor ignorou o Range: recomeça do zero
        have = 0;
        await pipeline(response.body, progressCounter(0, response, onProgress), createWriteStream(part, { flags: 'w' }));
      } else if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        const error = new Error(`O servidor respondeu ${response.status} para ${url}`);
        error.fatal = true;
        throw error;
      } else {
        throw new Error(`O servidor respondeu ${response.status}`);
      }
      const actual = await sha256File(part);
      if (actual !== expected) {
        await rm(part, { force: true }); // não retoma em cima de um arquivo ruim
        throw new ChecksumError(url, expected, actual);
      }
      await rename(part, dest);
      return { path: dest, cached: false };
    } catch (error) {
      if (error.fatal) throw error;
      lastError = error;
      if (error instanceof ChecksumError && attempt >= 1) throw error; // veio errado duas vezes: a fonte mudou ou foi adulterada
    }
  }
  throw lastError;
}

/** Uma etapa de pipeline que só conta os bytes e avisa o progresso (não altera os dados). */
function progressCounter(start, response, onProgress) {
  const length = Number(response.headers?.get?.('content-length') ?? 0);
  const total = length ? start + length : 0;
  let done = start;
  return async function* count(source) {
    for await (const chunk of source) {
      done += chunk.length;
      onProgress({ done, total });
      yield chunk;
    }
  };
}
