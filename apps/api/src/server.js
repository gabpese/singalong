import { Redis } from 'ioredis';
import { buildApp } from './app.js';
import { startCacheMaintenance } from './cache-cleaner.js';
import { loadConfig } from './config.js';
import { createRedisJobStore } from './jobs.js';
import { buildLoggerOptions } from './logging.js';
import { LocalStorage } from './storage.js';

const config = loadConfig();
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2 });
redis.on('error', (err) => app.log.error({ err: err.message }, 'redis'));

const jobs = createRedisJobStore(redis);
const storage = new LocalStorage(config.storageRoot, config.publicBaseUrl);
const app = buildApp({ config, storage, jobs, logger: buildLoggerOptions(config.logLevel) });

// limpeza do cache por uso: apaga as músicas menos tocadas quando a pasta passa do limite (CACHE_MAX_GB; 0 desliga)
const stopMaintenance = startCacheMaintenance({ storage, db: app.db, jobs, maxBytes: config.cacheMaxBytes, log: app.log });

// encerramento limpo (Docker/Kubernetes enviam SIGTERM)
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    app.log.info({ signal }, 'encerrando');
    stopMaintenance();
    await app.close();
    await jobs.close();
    process.exit(0);
  });
}

app.rooms.start(); // relógio das salas: avança a fila quando uma música fica pronta e difunde o progresso
await app.listen({ port: config.port, host: config.host });
