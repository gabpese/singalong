// The installed app's version: the comparison, the open endpoint, the notice in the heartbeat and work refused below the minimum.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildApp } from '../dist/app.js';
import { createMemoryJobStore } from '../dist/jobs.js';
import { LocalStorage } from '../dist/storage.js';
import { compareVersions, parseVersion, updateInfo } from '../dist/version.js';

test('parseVersion takes MAJOR.MINOR.PATCH and refuses the rest', () => {
  assert.deepEqual(parseVersion('1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseVersion('v0.10.0-beta.1'), [0, 10, 0]);
  for (const bad of ['', '1.2', '1.2.x', 'abc', null, undefined, '1.2.3.4', '1.2.3 ; drop']) assert.equal(parseVersion(bad), null, String(bad));
});

test('compareVersions compares number by number (0.10.0 is greater than 0.9.0)', () => {
  assert.ok(compareVersions('0.9.0', '0.10.0') < 0);
  assert.ok(compareVersions('2.0.0', '1.99.99') > 0);
  assert.equal(compareVersions('1.2.3', '1.2.3-beta'), 0);
  assert.equal(compareVersions('1.2', '1.2.3'), null);
});

test('updateInfo: up to date, update available, required and unknown', () => {
  const cfg = { latest: '1.3.0', minimum: '1.1.0', notes: 'Corrige o login', url: 'https://exemplo/baixar' };
  assert.equal(updateInfo('1.3.0', cfg).status, 'ok');
  assert.equal(updateInfo('1.4.0', cfg).status, 'ok');
  assert.equal(updateInfo('1.2.0', cfg).status, 'update_available');
  assert.equal(updateInfo('1.0.9', cfg).status, 'update_required');
  assert.equal(updateInfo('lixo', cfg).status, 'unknown');
  assert.equal(updateInfo('1.0.0', {}).status, 'unknown'); // nothing set: no notice
  assert.deepEqual(updateInfo('1.2.0', cfg), { current: '1.2.0', status: 'update_available', latest: '1.3.0', minimum: '1.1.0', notes: 'Corrige o login', url: 'https://exemplo/baixar' });
  assert.equal(updateInfo('1.0.0', { latest: 'quebrado', minimum: '1.0.0' }).latest, null); // a badly set value is ignored
});

async function build(extra) {
  const root = await mkdtemp(join(tmpdir(), 'singalong-ver-'));
  const app = await buildApp({
    config: { publicDir: root, adminToken: 'adm', rateLimits: { pair: { max: 1e6, windowMs: 60_000 }, createRoom: { max: 1e6, windowMs: 60_000 }, search: { max: 1e6, windowMs: 60_000 }, addToQueue: { max: 1e6, windowMs: 60_000 } }, ...extra },
    storage: new LocalStorage(root),
    jobs: createMemoryJobStore(),
  });
  await app.ready();
  return app;
}

async function pairAndStart(app) {
  const start = await app.inject({ method: 'POST', url: '/agent/v1/pair/start', headers: { 'x-admin-token': 'adm' }, payload: {} });
  const done = await app.inject({ method: 'POST', url: '/agent/v1/pair/complete', payload: { code: start.json().code, name: 'PC' } });
  const headers = { authorization: `Bearer ${done.json().token}` };
  await app.inject({ method: 'POST', url: '/agent/v1/sessions', headers, payload: { display_name: 'Dono' } });
  return headers;
}

test('GET /agent/v1/version is open and says what to do', async () => {
  const app = await build({ appLatestVersion: '1.3.0', appMinVersion: '1.1.0', appNotes: 'Corrige o login', appDownloadUrl: 'https://exemplo/baixar' });
  const res = await app.inject({ method: 'GET', url: '/agent/v1/version?current=1.2.0' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'update_available');
  assert.equal(res.json().notes, 'Corrige o login');
  assert.equal((await app.inject({ method: 'GET', url: '/agent/v1/version' })).json().status, 'unknown');
  await app.close();
});

test('the heartbeat returns the notice, and below the minimum the server refuses work (426) until the app updates', async () => {
  const app = await build({ appLatestVersion: '1.3.0', appMinVersion: '1.1.0' });
  const headers = await pairAndStart(app);
  const beat = (version) => app.inject({ method: 'POST', url: '/agent/v1/heartbeat', headers, payload: { version } });
  const claim = () => app.inject({ method: 'POST', url: '/agent/v1/jobs/claim', headers, payload: { wait_ms: 0 } });

  assert.equal((await claim()).statusCode, 204); // version still unknown: not blocked
  assert.equal((await beat('1.2.0')).json().update.status, 'update_available');
  assert.equal((await claim()).statusCode, 204);

  assert.equal((await beat('1.0.0')).json().update.status, 'update_required');
  const refused = await claim();
  assert.equal(refused.statusCode, 426);
  assert.equal(refused.json().error, 'update_required');

  assert.equal((await beat('1.3.0')).json().update.status, 'ok'); // it updated
  assert.equal((await claim()).statusCode, 204);
  await app.close();
});

test("GET /api/config: the app's address and version go out only when set (and the link must be http/https)", async () => {
  const configured = await build({ appLatestVersion: '1.3.0', appDownloadUrl: 'https://github.com/dono/repo/releases/latest', publicUrl: 'https://sing.example' });
  const body = (await configured.inject({ method: 'GET', url: '/api/config' })).json();
  assert.deepEqual([body.public_url, body.app_download_url, body.app_latest_version], ['https://sing.example', 'https://github.com/dono/repo/releases/latest', '1.3.0']);
  // the release page became the files folder (the most common mistake), and each system gets its link with the fixed name
  assert.equal(body.app_page_url, 'https://github.com/dono/repo/releases/latest');
  assert.deepEqual(body.app_downloads.map((d) => [d.system, d.arch, d.url]), [
    ['windows', 'x64', 'https://github.com/dono/repo/releases/latest/download/singalong_karaoke.exe'],
    ['macos', 'arm64', 'https://github.com/dono/repo/releases/latest/download/singalong_karaoke-mac-arm64.dmg'],
    ['linux', 'x64', 'https://github.com/dono/repo/releases/latest/download/singalong_karaoke-linux-x86_64.AppImage'],
  ]);
  await configured.close();

  const bare = await build({});
  assert.deepEqual((await bare.inject({ method: 'GET', url: '/api/config' })).json(), { public_url: null, app_download_url: null, app_latest_version: null, app_page_url: null, app_downloads: [] });
  await bare.close();

  const unsafe = await build({ appDownloadUrl: 'javascript:alert(1)' }); // a link that is not http(s) never goes into a button
  const unsafeBody = (await unsafe.inject({ method: 'GET', url: '/api/config' })).json();
  assert.deepEqual([unsafeBody.app_download_url, unsafeBody.app_page_url, unsafeBody.app_downloads], [null, null, []]);
  await unsafe.close();
});
