import { Redis } from 'ioredis';
import { type App, buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createRedisJobStore } from './jobs.ts';
import { buildLoggerOptions } from './logging.ts';
import { LocalStorage } from './storage.ts';

const config = loadConfig();
const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: 2 });
let app: App | undefined;
redis.on('error', (err) => app?.log.error({ err: err.message }, 'redis'));

const jobs = createRedisJobStore(redis);
const storage = new LocalStorage(config.storageRoot, config.publicBaseUrl);
app = await buildApp({ config, storage, jobs, logger: buildLoggerOptions(config.logLevel) });
const server = app;

// cache cleaning by use: deletes the least-sung songs when the folder goes over the limit (CACHE_MAX_GB; 0 turns it off)
const stopMaintenance = server.cacheCleaner.start({ maxBytes: config.cacheMaxBytes, log: server.log });

// a clean shutdown (Docker and Kubernetes send SIGTERM)
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    server.log.info({ signal }, 'shutting down');
    stopMaintenance();
    await server.close();
    await jobs.close();
    process.exit(0);
  });
}

// ends the agent Sessions that went days without a signal (the app closed without saying so); their requests become failures
const sweepSessions = setInterval(() => server.agents.sweep().catch((err: Error) => server.log.warn({ err: err.message }, 'session sweep')), 10 * 60 * 1000);
sweepSessions.unref();

server.rooms.start(); // the Rooms' clock: advances the queue when a song is ready and broadcasts the progress
await server.listen({ port: config.port, host: config.host });
