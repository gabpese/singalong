// Makes the app's icon (ui/icon.png and build/icon.ico) from the mark (brand/mark.svg, at the repository's root): the vinyl with
// the microphone on a square of cream paper, which shows well on both a dark and a light taskbar.
// build/icon.png comes out at 1024 px: macOS (.icns) and Linux (AppImage) need at least 512 px.
//   node_modules\electron\dist\electron.exe scripts\make-icon.ts      (without ELECTRON_RUN_AS_NODE)
import { app, BrowserWindow, nativeImage } from 'electron';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const svg = readFileSync(join(root, '..', '..', 'brand', 'mark.svg'), 'utf8').replace(/<\?xml[^>]*\?>|<!DOCTYPE[^>]*>/g, '');
const SIZES = [256, 128, 64, 48, 32, 24, 16];

async function render(size: number) {
  const win = new BrowserWindow({ show: false, width: size, height: size, useContentSize: true, transparent: true, frame: false, webPreferences: { offscreen: true } });
  const html = `<!doctype html><body style="margin:0;overflow:hidden;background:transparent"><div style="width:${size}px;height:${size}px">${svg.replace('<svg ', '<svg style="width:100%;height:100%" ')}</div>`;
  const file = join(tmpdir(), `singalong-icon-${size}.html`);
  writeFileSync(file, html);
  await win.loadFile(file);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const image = await win.webContents.capturePage();
  win.destroy();
  return image;
}

app.on('window-all-closed', () => {}); // without this Electron quits when the first window closes and the second render fails

app.whenReady().then(async () => {
  const pngs: Buffer[] = [];
  const big = await render(256); // renders once and scales down for the other sizes
  for (const size of SIZES) pngs.push(size === 256 ? big.toPNG() : nativeImage.createFromBuffer(big.toPNG()).resize({ width: size, height: size, quality: 'best' }).toPNG());
  writeFileSync(join(root, 'ui', 'icon.png'), pngs[0]);
  // an .ico with one PNG per size (Windows accepts it since Vista)
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
