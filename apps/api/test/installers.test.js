// Os links de download por sistema (a página inicial) e a concordância dos nomes com os do app e do electron-builder.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { downloadBase, downloadPage, downloadsFor, INSTALLERS } from '../dist/installers.js';

test('downloadBase: a pasta de arquivos; a página da release do GitHub é corrigida; o que não é http(s) é recusado', () => {
  assert.equal(downloadBase('https://github.com/dono/repo/releases/latest/download/'), 'https://github.com/dono/repo/releases/latest/download/');
  assert.equal(downloadBase('https://github.com/dono/repo/releases/latest/download'), 'https://github.com/dono/repo/releases/latest/download/'); // a barra que faltava
  assert.equal(downloadBase('https://github.com/dono/repo/releases/latest'), 'https://github.com/dono/repo/releases/latest/download/'); // a página virou a pasta
  assert.equal(downloadBase('https://github.com/dono/repo/releases/latest/?x=1#y'), 'https://github.com/dono/repo/releases/latest/download/');
  assert.equal(downloadBase('https://files.example/updates'), 'https://files.example/updates/');
  assert.equal(downloadBase('javascript:alert(1)'), null);
  assert.equal(downloadBase(''), null);
  assert.equal(downloadBase(undefined), null);
});

test('downloadPage: a página para ver as versões (sem o /download/ do GitHub, que não abre no navegador)', () => {
  assert.equal(downloadPage('https://github.com/dono/repo/releases/latest/download/'), 'https://github.com/dono/repo/releases/latest');
  assert.equal(downloadPage('https://github.com/dono/repo/releases/latest'), 'https://github.com/dono/repo/releases/latest');
  assert.equal(downloadPage('https://files.example/updates/'), 'https://files.example/updates/');
  assert.equal(downloadPage('ftp://x'), null);
});

test('downloadsFor: um link por sistema, na ordem windows, macos, linux; vazio sem endereço', () => {
  const list = downloadsFor('https://files.example/updates');
  assert.deepEqual(list.map((d) => d.system), ['windows', 'macos', 'linux']);
  assert.ok(list.every((d) => d.url === `https://files.example/updates/${d.file}`));
  assert.deepEqual(downloadsFor(null), []);
});

test('os nomes dos instaladores são os mesmos do app e do electron-builder', async () => {
  const { INSTALLERS: desktop } = await import('../../desktop/src/installers.ts');
  const system = { win32: 'windows', darwin: 'macos', linux: 'linux' };
  const arch = { x64: 'x64', arm64: 'arm64' };
  const fromDesktop = Object.entries(desktop).map(([key, file]) => {
    const [platform, cpu] = key.split('-');
    return { system: system[platform], arch: arch[cpu], file };
  });
  assert.deepEqual(INSTALLERS, fromDesktop);
});
