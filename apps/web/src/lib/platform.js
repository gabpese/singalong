// O app do dono (instalador) existe para computadores com Windows: celulares, tablets e outros sistemas não baixam um arquivo inútil.

/** Este navegador roda num computador Windows (e não num celular ou tablet)? `userAgent` = navigator.userAgent. */
export function canInstallApp(userAgent) {
  const ua = String(userAgent ?? '');
  return /Windows NT/i.test(ua) && !/Mobi|Android|iPhone|iPad|Windows Phone/i.test(ua);
}
