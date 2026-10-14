// Os instaladores do app, um por sistema, com nome FIXO: a página inicial oferece o do sistema do visitante (e a lista dos outros) montando o
// link a partir da base que o administrador publica (APP_DOWNLOAD_URL ou o cartão "Versão do app": a pasta `…/releases/latest/download/`).
// Os nomes são os mesmos do app (apps/desktop/src/installers.js) e do electron-builder; um teste do app confere que os três concordam.

export const INSTALLERS = [
  { system: 'windows', arch: 'x64', file: 'singalong_karaoke.exe' },
  { system: 'macos', arch: 'arm64', file: 'singalong_karaoke-mac-arm64.dmg' },
  { system: 'linux', arch: 'x64', file: 'singalong_karaoke-linux-x86_64.AppImage' },
];

/**
 * Quem cola o endereço da PÁGINA da release do GitHub (`…/releases/latest`) em vez da pasta de arquivos (`…/releases/latest/download/`)
 * tem o engano corrigido aqui: acrescentar o nome do arquivo à página daria um link quebrado.
 */
export function downloadBase(url) {
  const text = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(text)) return null;
  const clean = text.replace(/[?#].*$/, '').replace(/\/+$/, '');
  return /\/releases\/latest$/i.test(clean) ? `${clean}/download/` : `${clean}/`;
}

/** A página para ver todas as versões: a própria pasta de arquivos do GitHub não abre no navegador, então tira o `/download/`. */
export function downloadPage(url) {
  const base = downloadBase(url);
  return base ? base.replace(/\/download\/$/, '') : null;
}

/** Os links de download de cada sistema; vazio quando não há endereço (ou ele não é http/https). */
export function downloadsFor(url) {
  const base = downloadBase(url);
  return base ? INSTALLERS.map((item) => ({ ...item, url: `${base}${item.file}` })) : [];
}
