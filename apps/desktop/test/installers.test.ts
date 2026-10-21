// The installers per system: fixed names (the server and electron-builder must agree), the Mac's link and the AppImage's sandbox.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { INSTALLERS, installerFile, installerUrl, needsNoSandbox } from '../src/installers.ts';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('each system has an installer with a fixed name, and electron-builder makes exactly that name', () => {
  assert.deepEqual(INSTALLERS, {
    'win32-x64': 'singalong_karaoke.exe',
    'darwin-arm64': 'singalong_karaoke-mac-arm64.dmg',
    'linux-x64': 'singalong_karaoke-linux-x86_64.AppImage',
  });
  const name = (template: string, ext: string) => template.replace('${ext}', ext);
  assert.equal(name(pkg.build.win.artifactName, 'exe'), INSTALLERS['win32-x64']);
  assert.equal(name(pkg.build.mac.artifactName, 'dmg'), INSTALLERS['darwin-arm64']);
  assert.equal(name(pkg.build.dmg.artifactName, 'dmg'), INSTALLERS['darwin-arm64']);
  assert.equal(name(pkg.build.linux.artifactName, 'AppImage'), INSTALLERS['linux-x64']);
  assert.equal(name(pkg.build.appImage.artifactName, 'AppImage'), INSTALLERS['linux-x64']);
});

test("the Mac installer gets an ad-hoc signature (Apple Silicon kills an unsigned program) and no hardened runtime", () => {
  assert.equal(pkg.build.mac.identity, '-');
  assert.equal(pkg.build.mac.hardenedRuntime, false); // hardened + ad-hoc rejects the already signed Electron
  assert.deepEqual(pkg.build.mac.target, [{ target: 'dmg', arch: ['arm64'] }]);
  assert.deepEqual(pkg.build.linux.target, [{ target: 'AppImage', arch: ['x64'] }]);
});

test("the installer's link: the system's file inside the folder, or the folder itself when the system has no installer", () => {
  const base = 'https://github.com/gabpese/singalong/releases/latest/download/';
  assert.equal(installerFile('darwin', 'arm64'), 'singalong_karaoke-mac-arm64.dmg');
  assert.equal(installerFile('darwin', 'x64'), null); // an Intel Mac: no engine, no installer
  assert.equal(installerUrl(base, 'darwin', 'arm64'), `${base}singalong_karaoke-mac-arm64.dmg`);
  assert.equal(installerUrl('https://x.test/folder', 'linux', 'x64'), 'https://x.test/folder/singalong_karaoke-linux-x86_64.AppImage'); // the missing slash
  assert.equal(installerUrl(base, 'darwin', 'x64'), base);
  assert.equal(installerUrl(base, 'freebsd', 'x64'), base);
});

test('the sandbox is turned off only in the AppImage of a Linux that restricts user namespaces', () => {
  const kernel = (files: Record<string, string>) => (path: string) => {
    if (!(path in files)) throw new Error('ENOENT');
    return `${files[path]}\n`;
  };
  const appImage = '/tmp/.mount_x/AppRun';
  assert.equal(needsNoSandbox({ platform: 'linux', appImage, read: kernel({ '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1' }) }), true); // Ubuntu 24.04
  assert.equal(needsNoSandbox({ platform: 'linux', appImage, read: kernel({ '/proc/sys/kernel/unprivileged_userns_clone': '0' }) }), true); // Debian with the clone off
  assert.equal(needsNoSandbox({ platform: 'linux', appImage, read: kernel({ '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '0' }) }), false);
  assert.equal(needsNoSandbox({ platform: 'linux', appImage, read: kernel({}) }), false); // no restriction: the sandbox stays on
  assert.equal(needsNoSandbox({ platform: 'linux', appImage: undefined, read: kernel({ '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1' }) }), false); // outside the AppImage
  assert.equal(needsNoSandbox({ platform: 'win32', appImage, read: kernel({ '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1' }) }), false);
});
