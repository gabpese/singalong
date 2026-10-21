// A download that resumes and checks its SHA-256. A file only counts once its hash matches the manifest's.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pipeline } from 'node:stream/promises';

export class ChecksumError extends Error {
  code = 'checksum';

  constructor(file: string, expected: string, actual: string) {
    super(`O arquivo baixado não confere (esperado ${expected.slice(0, 12)}…, veio ${actual.slice(0, 12)}…): ${file}`);
  }
}

/** A failure not worth retrying (the server answered 4xx: the file is not there). */
type FatalError = Error & { fatal?: boolean };

export type DownloadProgress = (progress: { done: number; total: number }) => void;

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

const sizeOf = async (path: string) => (await stat(path).catch(() => null))?.size ?? 0;

/**
 * Downloads `url` to `dest`. When `dest` already exists and matches, it does not download again. What is downloaded goes to
 * `dest.part`, so a dropped network (or the app closing) resumes where it stopped, with `Range`. Returns { path, cached }.
 */
export async function download({
  url,
  dest,
  sha256,
  onProgress = () => {},
  fetchImpl = fetch,
  retries = 4,
  retryWait = 1000,
}: {
  url: string;
  dest: string;
  sha256: string;
  onProgress?: DownloadProgress;
  fetchImpl?: typeof fetch;
  retries?: number;
  retryWait?: number;
}): Promise<{ path: string; cached: boolean }> {
  const expected = String(sha256).toLowerCase();
  await mkdir(dirname(dest), { recursive: true });
  if ((await sizeOf(dest)) > 0 && (await sha256File(dest)) === expected) return { path: dest, cached: true };

  const part = `${dest}.part`;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, retryWait * attempt));
    try {
      let have = await sizeOf(part);
      const response = await fetchImpl(url, { headers: have > 0 ? { Range: `bytes=${have}-` } : {}, redirect: 'follow' });
      if (response.status === 416) { // what we have is already the whole file (or garbage): checked below
        have = await sizeOf(part);
      } else if (response.status === 206) {
        await pipeline(response.body!, progressCounter(have, response, onProgress), createWriteStream(part, { flags: 'a' }));
      } else if (response.ok) { // the server ignored the Range: start over
        have = 0;
        await pipeline(response.body!, progressCounter(0, response, onProgress), createWriteStream(part, { flags: 'w' }));
      } else if (response.status >= 400 && response.status < 500 && response.status !== 429) {
        const error: FatalError = new Error(`O servidor respondeu ${response.status} para ${url}`);
        error.fatal = true;
        throw error;
      } else {
        throw new Error(`O servidor respondeu ${response.status}`);
      }
      const actual = await sha256File(part);
      if (actual !== expected) {
        await rm(part, { force: true }); // never resume on top of a bad file
        throw new ChecksumError(url, expected, actual);
      }
      await rename(part, dest);
      return { path: dest, cached: false };
    } catch (error) {
      if ((error as FatalError).fatal) throw error;
      lastError = error;
      if (error instanceof ChecksumError && attempt >= 1) throw error; // wrong twice: the source changed or was tampered with
    }
  }
  throw lastError;
}

/** A pipeline step that only counts the bytes and reports the progress (it does not change the data). */
function progressCounter(start: number, response: Response, onProgress: DownloadProgress) {
  const length = Number(response.headers?.get?.('content-length') ?? 0);
  const total = length ? start + length : 0;
  let done = start;
  return async function* count(source: AsyncIterable<Uint8Array>) {
    for await (const chunk of source) {
      done += chunk.length;
      onProgress({ done, total });
      yield chunk;
    }
  };
}
