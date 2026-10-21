// The app's installers, one per system, with FIXED names: the landing page offers the visitor's system (and lists the others),
// building each link from the base the administrator publishes (APP_DOWNLOAD_URL or the admin page's app version: the folder
// `…/releases/latest/download/`). The names are the app's own (apps/desktop/src/installers.ts) and electron-builder's; an app
// test checks that the three agree.
import type { Download } from './protocol.ts';

export const INSTALLERS: Omit<Download, 'url'>[] = [
  { system: 'windows', arch: 'x64', file: 'singalong_karaoke.exe' },
  { system: 'macos', arch: 'arm64', file: 'singalong_karaoke-mac-arm64.dmg' },
  { system: 'linux', arch: 'x64', file: 'singalong_karaoke-linux-x86_64.AppImage' },
];

/**
 * Whoever pastes the address of the GitHub release PAGE (`…/releases/latest`) instead of its files folder
 * (`…/releases/latest/download/`) has the slip fixed here: adding a file name to the page would make a broken link.
 */
export function downloadBase(url: unknown): string | null {
  const text = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(text)) return null;
  const clean = text.replace(/[?#].*$/, '').replace(/\/+$/, '');
  return /\/releases\/latest$/i.test(clean) ? `${clean}/download/` : `${clean}/`;
}

/** The page with every version: GitHub's files folder itself does not open in a browser, so this drops the `/download/`. */
export function downloadPage(url: unknown): string | null {
  const base = downloadBase(url);
  return base ? base.replace(/\/download\/$/, '') : null;
}

/** Each system's download link; empty when there is no address (or it is not http/https). */
export function downloadsFor(url: unknown): Download[] {
  const base = downloadBase(url);
  return base ? INSTALLERS.map((item) => ({ ...item, url: `${base}${item.file}` })) : [];
}
