import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Toda a configuração vem de variáveis de ambiente (12-factor). */
export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? '0.0.0.0',
    storageRoot: resolve(env.STORAGE_ROOT ?? join(here, '..', '..', '..', 'storage')),
    publicDir: resolve(env.PUBLIC_DIR ?? join(here, '..', '..', 'web', 'public')),
    redisUrl: env.REDIS_URL ?? 'redis://localhost:6379/0',
    // URL pela qual o navegador alcança /media (vazio = mesma origem)
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? '').replace(/\/$/, ''),
  };
}
