// The published app version is kept in memory and read from the database when the API starts: a restart keeps it.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildApp } from '../dist/app.js';
import { createMemoryJobStore } from '../dist/jobs.js';
import { LocalStorage } from '../dist/storage.js';

const ADMIN_PATH = 'admin-path-for-tests-1234';
const ADMIN = { 'x-admin-token': 'admin-secret', 'content-type': 'application/json' };

test('a version published on the admin page survives a restart, and clearing it brings the .env back', async () => {
  const root = await mkdtemp(join(tmpdir(), 'singalong-release-'));
  const config = { publicDir: root, dbPath: join(root, 'singalong.db'), adminToken: 'admin-secret', adminPath: ADMIN_PATH, appLatestVersion: '1.0.0' };
  const start = () => buildApp({ config, storage: new LocalStorage(root), jobs: createMemoryJobStore() });
  const published = async (app) => (await app.inject({ method: 'GET', url: '/api/config' })).json();

  let app = await start();
  const body = JSON.stringify({ latest: '2.0.0', minimum: '1.5.0', notes: 'New', url: 'https://example.com/app' });
  assert.equal((await app.inject({ method: 'PUT', url: `/${ADMIN_PATH}/api/release`, headers: ADMIN, payload: body })).statusCode, 200);
  await app.close();

  app = await start();
  assert.equal(app.release.get().source, 'panel');
  assert.equal(app.release.get().latest, '2.0.0');
  assert.match(JSON.stringify(await published(app)), /2\.0\.0/);
  assert.equal((await app.inject({ method: 'DELETE', url: `/${ADMIN_PATH}/api/release`, headers: { 'x-admin-token': 'admin-secret' } })).json().removed, true);
  await app.close();

  app = await start();
  assert.deepEqual([app.release.get().source, app.release.get().latest], ['env', '1.0.0']);
  await app.close();
});
