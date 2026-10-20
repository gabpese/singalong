import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const emails = (list: string | undefined) => (list ?? '').split(',').map((email) => email.trim().toLowerCase()).filter(Boolean);

/** All the settings come from environment variables (12-factor). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  return {
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? '0.0.0.0',
    storageRoot: resolve(env.STORAGE_ROOT ?? join(here, '..', '..', '..', 'storage')),
    publicDir: resolve(env.PUBLIC_DIR ?? join(here, '..', '..', 'web', 'dist')),
    redisUrl: env.REDIS_URL ?? 'redis://localhost:6379/0',
    // the Rooms' and the Queue's SQLite (on a volume of its own: SQLite files do not like Windows bind mounts)
    dbPath: resolve(env.DB_PATH ?? join(here, '..', '..', '..', 'storage', 'singalong.db')),
    // the song cache's limit in GB (the cleaning deletes the least played); 0 turns it off
    cacheMaxBytes: Math.max(0, Number(env.CACHE_MAX_GB ?? 20)) * 1024 ** 3,
    logLevel: env.LOG_LEVEL ?? 'info',
    // the address phones use to reach this server (it goes in the TV's QR code); empty = the page's own
    publicUrl: (env.PUBLIC_URL ?? '').replace(/\/$/, ''),
    // the URL the browser reaches /media through (empty = the same origin)
    publicBaseUrl: (env.PUBLIC_BASE_URL ?? '').replace(/\/$/, ''),
    // the server administrator's secret: only with it can the local agent's pairing codes be made (empty = off)
    adminToken: env.ADMIN_TOKEN ?? '',
    // pairing by e-mail: the person asks for the code, and it is sent only to an e-mail on this list (comma-separated)
    pairAllowedEmails: emails(env.PAIR_ALLOWED_EMAILS),
    trustProxy: env.TRUST_PROXY === '1', // behind Caddy, the real IP comes in X-Forwarded-For (the limits per IP)
    // the admin page's SECRET address (e.g. ADMIN_PATH=my-admin-9f3k2x7q1m4z8p5a): without it the page does not exist. Only
    // letters, digits, _ and -, from 16 to 64 characters: an address easy to guess (/admin) is the first an attacker tries
    adminPath: /^[A-Za-z0-9_-]{16,64}$/.test(env.ADMIN_PATH ?? '') ? env.ADMIN_PATH! : '',
    // e-mails whose computers send their songs to the cloud by themselves (they must have paired by e-mail)
    cloudUploadEmails: emails(env.ENABLED_TO_SEND_TO_CLOUD),
    brevoApiKey: env.BREVO_API_KEY ?? '',
    mailFrom: env.MAIL_FROM ?? '',
    mailFromName: env.MAIL_FROM_NAME ?? 'Singalong',
    // the installed app's versions, when the admin page has published none: the latest, the minimum that still gets work,
    // what changed and where to download it (empty = no notice)
    appLatestVersion: env.APP_LATEST_VERSION ?? '',
    appMinVersion: env.APP_MIN_VERSION ?? '',
    appNotes: (env.APP_NOTES ?? '').slice(0, 500),
    appDownloadUrl: env.APP_DOWNLOAD_URL ?? '',
    // the Intermission (seconds): the applause after each song and the next singer's walk to the stage; 0 turns a phase off
    intermissionApplauseMs: Math.max(0, Number(env.INTERMISSION_APPLAUSE_SECONDS ?? 15)) * 1000,
    intermissionStageMs: Math.max(0, Number(env.INTERMISSION_STAGE_SECONDS ?? 15)) * 1000,
  };
}
