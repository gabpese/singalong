// The owner's app (installer) exists for computers running Windows, macOS (Apple Silicon) and Linux: phones, tablets and other
// systems do not download a useless file.

export type System = 'windows' | 'macos' | 'linux' | 'phone' | 'other';

/**
 * The visitor's system from `navigator.userAgent`: 'windows' | 'macos' | 'linux' | 'phone' (phone or tablet) | 'other'.
 * A Mac does not say whether it is Intel or Apple Silicon (the browser always presents itself as Intel): the person decides, on the page.
 */
export function detectSystem(userAgent?: string | null): System {
  const ua = String(userAgent ?? '');
  if (/Mobi|Android|iPhone|iPad|iPod|Windows Phone|CrOS/i.test(ua)) return 'phone'; // CrOS (Chromebook) has no installer
  if (/Windows NT/i.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'macos';
  if (/Linux|X11/i.test(ua)) return 'linux';
  return 'other';
}

/** Does this browser run on a computer that has an installer (Windows, macOS or Linux)? */
export const canInstallApp = (userAgent?: string | null): boolean => ['windows', 'macos', 'linux'].includes(detectSystem(userAgent));
