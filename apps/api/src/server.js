import { Redis } from 'ioredis';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createRedisJobStore } from './jobs.js';
import { LocalStorage } from './storage.js';

const config = loadConfig();
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2 });
redis.on('error', (err) => app.log.error({ err: err.message }, 'redis'));

const jobs = createRedisJobStore(redis);
const storage = new LocalStorage(config.storageRoot, config.publicBaseUrl);
const app = buildApp({ config, storage, jobs, logger: { level: process.env.LOG_LEVEL ?? 'info' } });

// encerramento limpo (Docker/Kubernetes enviam SIGTERM)
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    app.log.info({ signal }, 'encerrando');
    await app.close();
    await jobs.close();
    process.exit(0);
  });
}

await app.listen({ port: config.port, host: config.host });
