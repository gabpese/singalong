import type { AppConfig } from '../app.ts';

/**
 * The admin page's secret address (ADMIN_PATH), or null when the administration does not exist: without the token AND the
 * address no route is registered, so everything is a 404. Only letters, digits, _ and -, 16 to 64 characters (config.js
 * already filters it; checked again here, to be sure).
 */
export function adminPathOf(config: AppConfig): string | null {
  return config.adminToken && config.adminPath && /^[A-Za-z0-9_-]{16,64}$/.test(config.adminPath) ? config.adminPath : null;
}
