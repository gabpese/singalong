// The admin page itself: static files that never carry the token. Whoever opens the page types the secret, which stays only in
// that browser tab (sessionStorage). No cookies, so no CSRF. It stays a Fastify route because its address must end in "/"
// (the files next to it load by relative path), and Nest does not tell "/path" from "/path/".
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { AppConfig } from '../app.ts';
import { adminPathOf } from './admin-path.ts';

const here = dirname(fileURLToPath(import.meta.url));
const ASSETS: Record<string, [file: string, type: string]> = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/admin.js': ['admin.js', 'text/javascript; charset=utf-8'],
  '/admin.css': ['admin.css', 'text/css; charset=utf-8'],
};
// the page only loads what is its own and talks to nobody else
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export async function adminPage(app: FastifyInstance, { config }: { config: AppConfig }) {
  const path = adminPathOf(config);
  if (!path) return;
  const base = `/${path}`;
  app.get(base, async (request, reply) => reply.redirect(`${base}/`));
  for (const [route, [file, type]] of Object.entries(ASSETS)) {
    app.get(`${base}${route}`, async (request, reply) => {
      const body = await readFile(join(here, 'page', file));
      return reply
        .header('content-type', type)
        .header('content-security-policy', CSP)
        .header('x-frame-options', 'DENY')
        .header('cache-control', 'no-store')
        .header('x-robots-tag', 'noindex')
        .send(body);
    });
  }
}
