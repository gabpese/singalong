// Gera o ícone do app (ui/icon.png e build/icon.ico) a partir da marca (brand/mark.svg, na raiz do repositório): o vinil com o
// microfone num quadrado de papel creme, que aparece bem na barra de tarefas escura e na clara.
// build/icon.png sai em 1024 px: o macOS (.icns) e o Linux (AppImage) exigem pelo menos 512 px.
//   node_modules\electron\dist\electron.exe scripts\make-icon.cjs      (sem ELECTRON_RUN_AS_NODE)
const { app, BrowserWindow, nativeImage } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

const root = join(__dirname, '..');
const svg = readFileSync(join(root, '..', '..', 'brand', 'mark.svg'), 'utf8').replace(/<\?xml[^>]*\?>|<!DOCTYPE[^>]*>/g, '');
const SIZES = [256, 128, 64, 48, 32, 24, 16];

async function render(size) {
  const win = new BrowserWindow({ show: false, width: size, height: size, useContentSize: true, transparent: true, frame: false, webPreferences: { offscreen: true } });
  const html = `<!doctype html><body style="margin:0;background:transparent"><div style="width:${size}px;height:${size}px">${svg.replace('<svg ', '<svg style="width:100%;height:100%" ')}</div>`;
  const file = join(tmpdir(), `singalong-icon-${size}.html`);
  writeFileSync(file, html);
  await win.loadFile(file);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const image = await win.webContents.capturePage();
  win.destroy();
  return image;
}

app.on('window-all-closed', () => {}); // sem isto o Electron encerra ao fechar a primeira janela e a segunda renderização falha

app.whenReady().then(async () => {
  const pngs = [];
  const big = await render(256); // renderiza uma vez e reduz para os outros tamanhos
  for (const size of SIZES) pngs.push(size === 256 ? big.toPNG() : nativeImage.createFromBuffer(big.toPNG()).resize({ width: size, height: size, quality: 'best' }).toPNG());
  writeFileSync(join(root, 'ui', 'icon.png'), pngs[0]);
  // .ico com um PNG por tamanho (aceito pelo Windows desde o Vista)
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(SIZES.length, 4);
  let offset = 6 + 16 * SIZES.length;
  const entries = SIZES.map((size, i) => {
    const entry = Buffer.alloc(16);
    entry.writeUInt8(size >= 256 ? 0 : size, 0);
    entry.writeUInt8(size >= 256 ? 0 : size, 1);
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(pngs[i].length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += pngs[i].length;
    return entry;
  });
  writeFileSync(join(root, 'build', 'icon.ico'), Buffer.concat([header, ...entries, ...pngs]));
  writeFileSync(join(root, 'build', 'icon.png'), (await render(1024)).toPNG());
  app.quit();
});
