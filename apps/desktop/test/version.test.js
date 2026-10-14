// A versão do app existe em três lugares (o instalador, a interface e o worker): têm de andar juntas.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { APP_VERSION } from '../src/controller.js';

test('package.json, controlador e worker têm a mesma versão', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const worker = /__version__ = "([^"]+)"/.exec(await readFile(new URL('../../worker/singalong_worker/version.py', import.meta.url), 'utf8'))[1];
  assert.equal(pkg.version, APP_VERSION);
  assert.equal(worker, APP_VERSION);
});

test('o instalador se chama singalong_karaoke.exe e instala só para o usuário; a assinatura vem do ambiente (scripts/signing.mjs), nunca fixa no package.json', async () => {
  const { build } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(build.win.artifactName, 'singalong_karaoke.${ext}');
  assert.equal(build.nsis.artifactName, 'singalong_karaoke.${ext}');
  assert.equal(build.nsis.perMachine, false); // sem administrador
  // nenhum certificado nem senha fica escrito no package.json: quem decide se assina é o ambiente do build
  assert.equal(build.win.signtoolOptions, undefined);
  assert.equal(build.win.azureSignOptions, undefined);
  assert.equal(build.win.certificateFile, undefined);
});
