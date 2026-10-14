// O app do dono (instalador) existe para computadores com Windows, macOS (Apple Silicon) e Linux: celulares, tablets e outros sistemas
// não baixam um arquivo inútil.

/**
 * O sistema do visitante pelo `navigator.userAgent`: 'windows' | 'macos' | 'linux' | 'phone' (celular ou tablet) | 'other'.
 * O Mac não diz se é Intel ou Apple Silicon (o navegador sempre se apresenta como Intel): quem decide é a pessoa, na página.
 */
export function detectSystem(userAgent) {
  const ua = String(userAgent ?? '');
  if (/Mobi|Android|iPhone|iPad|iPod|Windows Phone|CrOS/i.test(ua)) return 'phone'; // CrOS (Chromebook) não tem instalador
  if (/Windows NT/i.test(ua)) return 'windows';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'macos';
  if (/Linux|X11/i.test(ua)) return 'linux';
  return 'other';
}

/** Este navegador roda num computador que tem instalador (Windows, macOS ou Linux)? */
export const canInstallApp = (userAgent) => ['windows', 'macos', 'linux'].includes(detectSystem(userAgent));
