// The app's version lives in three places (the installer, the window and the worker): they must move together.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { APP_VERSION } from '../src/controller.ts';

const readPackage = async () => JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('package.json, the controller and the worker have the same version', async () => {
  const pkg = await readPackage();
  const worker = /__version__ = "([^"]+)"/.exec(await readFile(new URL('../../worker/singalong_worker/version.py', import.meta.url), 'utf8'))?.[1];
  assert.equal(pkg.version, APP_VERSION);
  assert.equal(worker, APP_VERSION);
});

test('the installer is called singalong_karaoke.exe and installs for the user only; the signature comes from the environment (scripts/signing.ts), never fixed in package.json', async () => {
  const { build } = await readPackage();
  assert.equal(build.win.artifactName, 'singalong_karaoke.${ext}');
  assert.equal(build.nsis.artifactName, 'singalong_karaoke.${ext}');
  assert.equal(build.nsis.perMachine, false); // no administrator
  // no certificate or password is written in package.json: the build's environment decides whether to sign
  assert.equal(build.win.signtoolOptions, undefined);
  assert.equal(build.win.azureSignOptions, undefined);
  assert.equal(build.win.certificateFile, undefined);
});
