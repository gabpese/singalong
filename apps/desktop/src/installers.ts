// The installers published on the GitHub release, one per system, with a FIXED name: the server builds each download link from
// the base (APP_DOWNLOAD_URL, the `…/releases/latest/download/` folder), and the owner's app opens its own system's.
// Whoever changes a name changes it here, in electron-builder (package.json) and on the server (apps/api/src/installers.ts); a
// test checks all three.

/** System and architecture (`process.platform`-`process.arch`) → the installer's file. */
export const INSTALLERS: Record<string, string> = {
  'win32-x64': 'singalong_karaoke.exe',
  'darwin-arm64': 'singalong_karaoke-mac-arm64.dmg',
  'linux-x64': 'singalong_karaoke-linux-x86_64.AppImage',
};

export const installerFile = (platform: string = process.platform, arch: string = process.arch): string | null => INSTALLERS[`${platform}-${arch}`] ?? null;

/** This system's installer link inside the `base` folder; without an installer for it, the folder itself. */
export function installerUrl(base: string, platform: string = process.platform, arch: string = process.arch): string {
  const file = installerFile(platform, arch);
  return file ? `${String(base).replace(/\/?$/, '/')}${file}` : String(base);
}

/**
 * Linux without Chrome's sandbox: inside an AppImage, `chrome-sandbox` lacks the setuid bit and, on distributions that restrict
 * user namespaces (Ubuntu 24.04+), the fallback sandbox is blocked too and Electron does not even open. Only then does the app
 * turn on `--no-sandbox`; everywhere else the sandbox stays on.
 */
export function needsNoSandbox({ platform = process.platform, appImage = process.env.APPIMAGE, read }: { platform?: string; appImage?: string; read: (path: string) => string }): boolean {
  if (platform !== 'linux' || !appImage) return false;
  const value = (path: string) => {
    try {
      return String(read(path)).trim();
    } catch {
      return null;
    }
  };
  return value('/proc/sys/kernel/apparmor_restrict_unprivileged_userns') === '1' || value('/proc/sys/kernel/unprivileged_userns_clone') === '0';
}
