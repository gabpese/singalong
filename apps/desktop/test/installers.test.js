// Os instaladores por sistema: nomes fixos (o servidor e o electron-builder têm de concordar), o link do Mac e o sandbox do AppImage.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { INSTALLERS, installerFile, installerUrl, needsNoSandbox } from '../src/installers.ts';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('cada sistema tem um instalador de nome fixo, e o electron-builder gera exatamente esse nome', () => {
  assert.deepEqual(INSTALLERS, {
    'win32-x64': 'singalong_karaoke.exe',
    'darwin-arm64': 'singalong_karaoke-mac-arm64.dmg',
    'linux-x64': 'singalong_karaoke-linux-x86_64.AppImage',
  });
  const name = (template, ext) => template.replace('${ext}', ext);
  assert.equal(name(pkg.build.win.artifactName, 'exe'), INSTALLERS['win32-x64']);
  assert.equal(name(pkg.build.mac.artifactName, 'dmg'), INSTALLERS['darwin-arm64']);
  assert.equal(name(pkg.build.dmg.artifactName, 'dmg'), INSTALLERS['darwin-arm64']);
  assert.equal(name(pkg.build.linux.artifactName, 'AppImage'), INSTALLERS['linux-x64']);
  assert.equal(name(pkg.build.appImage.artifactName, 'AppImage'), INSTALLERS['linux-x64']);
});

test('o instalador do Mac vai com assinatura ad-hoc (o Apple Silicon encerra programa sem assinatura) e sem o runtime reforçado', () => {
  assert.equal(pkg.build.mac.identity, '-');
  assert.equal(pkg.build.mac.hardenedRuntime, false); // reforçado + ad-hoc rejeita o Electron já assinado
  assert.deepEqual(pkg.build.mac.target, [{ target: 'dmg', arch: ['arm64'] }]);
  assert.deepEqual(pkg.build.linux.target, [{ target: 'AppImage', arch: ['x64'] }]);
});

test('o link do instalador: o arquivo do sistema dentro da pasta, ou a própria pasta quando o sistema não tem instalador', () => {
  const base = 'https://github.com/gabpese/singalong/releases/latest/download/';
  assert.equal(installerFile('darwin', 'arm64'), 'singalong_karaoke-mac-arm64.dmg');
  assert.equal(installerFile('darwin', 'x64'), null); // Mac Intel: sem motor, sem instalador
  assert.equal(installerUrl(base, 'darwin', 'arm64'), `${base}singalong_karaoke-mac-arm64.dmg`);
  assert.equal(installerUrl('https://x.test/pasta', 'linux', 'x64'), 'https://x.test/pasta/singalong_karaoke-linux-x86_64.AppImage'); // a barra que faltava
  assert.equal(installerUrl(base, 'darwin', 'x64'), base);
  assert.equal(installerUrl(base, 'freebsd', 'x64'), base);
});

test('o sandbox só é desligado no AppImage de um Linux que restringe os namespaces de usuário', () => {
  const kernel = (files) => (path) => {
    if (!(path in files)) throw new Error('ENOENT');
    return `${files[path]}\n`;
  };
  const appImage = '/tmp/.mount_x/AppRun';
  assert.equal(needsNoSandbox({ platform: 'linux', appImage, read: kernel({ '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1' }) }), true); // Ubuntu 24.04
  assert.equal(needsNoSandbox({ platform: 'linux', appImage, read: kernel({ '/proc/sys/kernel/unprivileged_userns_clone': '0' }) }), true); // Debian com o clone desligado
  assert.equal(needsNoSandbox({ platform: 'linux', appImage, read: kernel({ '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '0' }) }), false);
  assert.equal(needsNoSandbox({ platform: 'linux', appImage, read: kernel({}) }), false); // sem a restrição: o sandbox fica ligado
  assert.equal(needsNoSandbox({ platform: 'linux', appImage: undefined, read: kernel({ '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1' }) }), false); // fora do AppImage
  assert.equal(needsNoSandbox({ platform: 'win32', appImage, read: kernel({ '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1' }) }), false);
});
