// Versão do app instalado: comparação, o endpoint aberto, o aviso no heartbeat e a recusa de trabalho abaixo da mínima.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { createMemoryJobStore } from '../src/jobs.js';
import { LocalStorage } from '../src/storage.js';
import { compareVersions, parseVersion, updateInfo } from '../src/version.js';

test('parseVersion aceita MAIOR.MENOR.CORREÇÃO e recusa o resto', () => {
  assert.deepEqual(parseVersion('1.2.3'), [1, 2, 3]);
  assert.deepEqual(parseVersion('v0.10.0-beta.1'), [0, 10, 0]);
  for (const bad of ['', '1.2', '1.2.x', 'abc', null, undefined, '1.2.3.4', '1.2.3 ; drop']) assert.equal(parseVersion(bad), null, String(bad));
});

test('compareVersions compara número a número (0.10.0 é maior que 0.9.0)', () => {
  assert.ok(compareVersions('0.9.0', '0.10.0') < 0);
  assert.ok(compareVersions('2.0.0', '1.99.99') > 0);
  assert.equal(compareVersions('1.2.3', '1.2.3-beta'), 0);
  assert.equal(compareVersions('1.2', '1.2.3'), null);
});

test('updateInfo: em dia, atualização disponível, obrigatória e desconhecida', () => {
  const cfg = { latest: '1.3.0', minimum: '1.1.0', notes: 'Corrige o login', url: 'https://exemplo/baixar' };
  assert.equal(updateInfo('1.3.0', cfg).status, 'ok');
  assert.equal(updateInfo('1.4.0', cfg).status, 'ok');
  assert.equal(updateInfo('1.2.0', cfg).status, 'update_available');
  assert.equal(updateInfo('1.0.9', cfg).status, 'update_required');
  assert.equal(updateInfo('lixo', cfg).status, 'unknown');
  assert.equal(updateInfo('1.0.0', {}).status, 'unknown'); // nada configurado: não avisa
  assert.deepEqual(updateInfo('1.2.0', cfg), { current: '1.2.0', status: 'update_available', latest: '1.3.0', minimum: '1.1.0', notes: 'Corrige o login', url: 'https://exemplo/baixar' });
  assert.equal(updateInfo('1.0.0', { latest: 'quebrado', minimum: '1.0.0' }).latest, null); // valor mal configurado é ignorado
});

async function build(extra) {
  const root = await mkdtemp(join(tmpdir(), 'singalong-ver-'));
  const app = buildApp({
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

test('GET /agent/v1/version é aberto e diz o que fazer', async () => {
  const app = await build({ appLatestVersion: '1.3.0', appMinVersion: '1.1.0', appNotes: 'Corrige o login', appDownloadUrl: 'https://exemplo/baixar' });
  const res = await app.inject({ method: 'GET', url: '/agent/v1/version?current=1.2.0' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().status, 'update_available');
  assert.equal(res.json().notes, 'Corrige o login');
  assert.equal((await app.inject({ method: 'GET', url: '/agent/v1/version' })).json().status, 'unknown');
  await app.close();
});

test('o heartbeat devolve o aviso e abaixo da mínima o servidor recusa trabalho (426) até atualizar', async () => {
  const app = await build({ appLatestVersion: '1.3.0', appMinVersion: '1.1.0' });
  const headers = await pairAndStart(app);
  const beat = (version) => app.inject({ method: 'POST', url: '/agent/v1/heartbeat', headers, payload: { version } });
  const claim = () => app.inject({ method: 'POST', url: '/agent/v1/jobs/claim', headers, payload: { wait_ms: 0 } });

  assert.equal((await claim()).statusCode, 204); // versão ainda desconhecida: não bloqueia
  assert.equal((await beat('1.2.0')).json().update.status, 'update_available');
  assert.equal((await claim()).statusCode, 204);

  assert.equal((await beat('1.0.0')).json().update.status, 'update_required');
  const refused = await claim();
  assert.equal(refused.statusCode, 426);
  assert.equal(refused.json().error, 'update_required');

  assert.equal((await beat('1.3.0')).json().update.status, 'ok'); // atualizou
  assert.equal((await claim()).statusCode, 204);
  await app.close();
});
