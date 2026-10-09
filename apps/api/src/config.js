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
    // SQLite das salas e da fila (num volume próprio: arquivos SQLite não gostam de bind mounts do Windows)
    dbPath: resolve(env.DB_PATH ?? join(here, '..', '..', '..', 'storage', 'singalong.db')),
    // limite do cache de músicas em GB (a limpeza apaga as menos tocadas); 0 desliga
    cacheMaxBytes: Math.max(0, Number(env.CACHE_MAX_GB ?? 20)) * 1024 ** 3,
    logLevel: env.LOG_LEVEL ?? 'info',
    // endereço que os celulares usam para chegar aqui (vai no QR code da TV); vazio = o da própria página
    publicUrl: (env.PUBLIC_URL ?? '').replace(/\/$/, ''),
    // URL pela qual o navegador alcança /media (vazio = mesma origem)
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? '').replace(/\/$/, ''),
  };
}
