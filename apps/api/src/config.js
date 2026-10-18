import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** Toda a configuração vem de variáveis de ambiente (12-factor). */
export function loadConfig(env = process.env) {
  return {
    port: Number(env.PORT ?? 3000),
    host: env.HOST ?? '0.0.0.0',
    storageRoot: resolve(env.STORAGE_ROOT ?? join(here, '..', '..', '..', 'storage')),
    publicDir: resolve(env.PUBLIC_DIR ?? join(here, '..', '..', 'web', 'dist')),
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
    // segredo do administrador do servidor: só com ele dá para gerar códigos de pareamento do agente local (vazio = desligado)
    adminToken: env.ADMIN_TOKEN ?? '',
    // versões do app instalado (agente): a mais recente, a mínima que ainda recebe trabalho, o que mudou e onde baixar (vazio = não avisa)
    // pareamento por e-mail: a pessoa pede o código e ele só é enviado se o e-mail estiver na lista (separada por vírgulas)
    pairAllowedEmails: (env.PAIR_ALLOWED_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
    trustProxy: env.TRUST_PROXY === '1', // atrás do Caddy o IP de verdade vem no X-Forwarded-For (limites por IP)
    // o endereço SECRETO da página do administrador (ex.: ADMIN_PATH=minha-gestao-9f3k2x7q1m4z8p5a): sem ele a página não existe.
    // Só letras, números, _ e -, de 16 a 64 caracteres: um caminho fácil de adivinhar (/admin) é o primeiro que um atacante tenta.
    adminPath: /^[A-Za-z0-9_-]{16,64}$/.test(env.ADMIN_PATH ?? '') ? env.ADMIN_PATH : '',
    // e-mails cujos computadores enviam as músicas para a nuvem sozinhos (precisam ter pareado por e-mail)
    cloudUploadEmails: (env.ENABLED_TO_SEND_TO_CLOUD ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
    brevoApiKey: env.BREVO_API_KEY ?? '',
    mailFrom: env.MAIL_FROM ?? '',
    mailFromName: env.MAIL_FROM_NAME ?? 'Singalong',
    appLatestVersion: env.APP_LATEST_VERSION ?? '',
    appMinVersion: env.APP_MIN_VERSION ?? '',
    appNotes: (env.APP_NOTES ?? '').slice(0, 500),
    appDownloadUrl: env.APP_DOWNLOAD_URL ?? '',
    // intervalo entre músicas (segundos): os aplausos depois de cada música e a subida ao palco do próximo cantor; 0 desliga a fase
    intermissionApplauseMs: Math.max(0, Number(env.INTERMISSION_APPLAUSE_SECONDS ?? 15)) * 1000,
    intermissionStageMs: Math.max(0, Number(env.INTERMISSION_STAGE_SECONDS ?? 15)) * 1000,
  };
}
