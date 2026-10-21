// The download links per system (the home page), and that their names match the app's and electron-builder's.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { downloadBase, downloadPage, downloadsFor, INSTALLERS } from '../dist/installers.js';

test("downloadBase: the files folder; GitHub's release page is corrected; what is not http(s) is refused", () => {
  assert.equal(downloadBase('https://github.com/dono/repo/releases/latest/download/'), 'https://github.com/dono/repo/releases/latest/download/');
  assert.equal(downloadBase('https://github.com/dono/repo/releases/latest/download'), 'https://github.com/dono/repo/releases/latest/download/'); // the missing slash
  assert.equal(downloadBase('https://github.com/dono/repo/releases/latest'), 'https://github.com/dono/repo/releases/latest/download/'); // the page became the folder
  assert.equal(downloadBase('https://github.com/dono/repo/releases/latest/?x=1#y'), 'https://github.com/dono/repo/releases/latest/download/');
  assert.equal(downloadBase('https://files.example/updates'), 'https://files.example/updates/');
  assert.equal(downloadBase('javascript:alert(1)'), null);
  assert.equal(downloadBase(''), null);
  assert.equal(downloadBase(undefined), null);
});

test("downloadPage: the page that lists the versions (without GitHub's /download/, which does not open in a browser)", () => {
  assert.equal(downloadPage('https://github.com/dono/repo/releases/latest/download/'), 'https://github.com/dono/repo/releases/latest');
  assert.equal(downloadPage('https://github.com/dono/repo/releases/latest'), 'https://github.com/dono/repo/releases/latest');
  assert.equal(downloadPage('https://files.example/updates/'), 'https://files.example/updates/');
  assert.equal(downloadPage('ftp://x'), null);
});

test('downloadsFor: one link per system, in the order windows, macos, linux; empty without an address', () => {
  const list = downloadsFor('https://files.example/updates');
  assert.deepEqual(list.map((d) => d.system), ['windows', 'macos', 'linux']);
  assert.ok(list.every((d) => d.url === `https://files.example/updates/${d.file}`));
  assert.deepEqual(downloadsFor(null), []);
});

test("the installers' names are the same as the app's and electron-builder's", async () => {
  const { INSTALLERS: desktop } = await import('../../desktop/src/installers.ts');
  const system = { win32: 'windows', darwin: 'macos', linux: 'linux' };
  const arch = { x64: 'x64', arm64: 'arm64' };
  const fromDesktop = Object.entries(desktop).map(([key, file]) => {
    const [platform, cpu] = key.split('-');
    return { system: system[platform], arch: arch[cpu], file };
  });
  assert.deepEqual(INSTALLERS, fromDesktop);
});
