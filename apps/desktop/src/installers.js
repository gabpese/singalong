// Os instaladores publicados na release do GitHub, um por sistema, com nome FIXO: o servidor monta o link de download de cada um
// a partir da base (APP_DOWNLOAD_URL, a pasta `…/releases/latest/download/`) e o app do dono abre o do próprio sistema.
// Quem muda um nome muda aqui, no electron-builder (package.json) e no servidor (apps/api/src/installers.ts); um teste confere os três.

/** Sistema e arquitetura (`process.platform`-`process.arch`) → arquivo do instalador. */
export const INSTALLERS = {
  'win32-x64': 'singalong_karaoke.exe',
  'darwin-arm64': 'singalong_karaoke-mac-arm64.dmg',
  'linux-x64': 'singalong_karaoke-linux-x86_64.AppImage',
};

export const installerFile = (platform = process.platform, arch = process.arch) => INSTALLERS[`${platform}-${arch}`] ?? null;

/** O link do instalador deste sistema dentro da pasta `base`; sem instalador para ele, a própria pasta. */
export function installerUrl(base, platform = process.platform, arch = process.arch) {
  const file = installerFile(platform, arch);
  return file ? `${String(base).replace(/\/?$/, '/')}${file}` : String(base);
}

/**
 * O Linux sem o sandbox do Chrome: dentro de um AppImage o `chrome-sandbox` não tem o bit setuid e, em distribuições que restringem
 * os namespaces de usuário (Ubuntu 24.04+), o sandbox alternativo também é barrado e o Electron nem abre. Só nesse caso o app liga
 * `--no-sandbox`; nos demais o sandbox continua ligado.
 */
export function needsNoSandbox({ platform = process.platform, appImage = process.env.APPIMAGE, read } = {}) {
  if (platform !== 'linux' || !appImage) return false;
  const value = (path) => {
    try {
      return String(read(path)).trim();
    } catch {
      return null;
    }
  };
  return value('/proc/sys/kernel/apparmor_restrict_unprivileged_userns') === '1' || value('/proc/sys/kernel/unprivileged_userns_clone') === '0';
}
