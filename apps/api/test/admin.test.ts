// The admin page and API: only with ADMIN_TOKEN; authorized e-mails, paired computers and the songs in the cloud.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildApp } from '../dist/app.js';
import { createMemoryJobStore } from '../dist/jobs.js';
import { LocalStorage } from '../dist/storage.js';

const LOOSE = { max: 1e6, windowMs: 60_000 };
const ADMIN = { 'x-admin-token': 'segredo-do-admin' };
const PATH = 'gestao-secreta-9f3k2x7q1m4z8p5a'; // the page's secret address (ADMIN_PATH)
const SONG = 'abcdefghijk';
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(300, 1)]);
const meta = Buffer.from(JSON.stringify({ video_id: SONG, title: 'Tempo Perdido', artist: 'Legião Urbana' }));

async function build({ config = {}, rateLimits = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'singalong-admin-'));
  const sent = [];
  const app = await buildApp({
    config: { publicDir: root, adminToken: 'segredo-do-admin', adminPath: PATH, pairAllowedEmails: [], cloudUploadEmails: [], brevoApiKey: 'k', mailFrom: 'a@b.com', rateLimits: { pair: LOOSE, pairRequest: LOOSE, pairEmail: LOOSE, admin: LOOSE, adminFail: LOOSE, ...rateLimits }, ...config },
    storage: new LocalStorage(root),
    jobs: createMemoryJobStore(),
    mailer: { enabled: true, send: async (message) => { sent.push(message); } },
  });
  await app.ready();
  return { app, sent };
}

const admin = (app, method, url, payload) => app.inject({ method, url: `/${PATH}/api${url}`, headers: ADMIN, payload });

async function pairByEmail(app, sent, email) {
  sent.length = 0;
  assert.equal((await app.inject({ method: 'POST', url: '/agent/v1/pair/request', payload: { email } })).statusCode, 202);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const code = /código[^:]*: ([A-Z0-9]{8})/.exec(sent.at(-1).text)[1];
  const done = await app.inject({ method: 'POST', url: '/agent/v1/pair/complete', payload: { code, name: `PC ${email}` } });
  return { id: done.json().device_id, headers: { authorization: `Bearer ${done.json().token}` } };
}

const put = (app, agent, id, file, body) => app.inject({ method: 'PUT', url: `/agent/v1/cloud/${id}/${file}`, headers: { ...agent.headers, 'content-type': 'application/octet-stream' }, payload: body });

async function uploadSong(app, agent) {
  await put(app, agent, SONG, 'instrumental.mp3', MP3);
  await put(app, agent, SONG, 'lyrics.json', Buffer.from('[]'));
  assert.equal((await put(app, agent, SONG, 'meta.json', meta)).statusCode, 204);
}

test('the page exists only at the SECRET address, does not carry the token and has a strict CSP', async () => {
  const { app } = await build();
  const redirect = await app.inject({ method: 'GET', url: `/${PATH}` });
  assert.equal(redirect.statusCode, 302);
  assert.equal(redirect.headers.location, `/${PATH}/`);
  const page = await app.inject({ method: 'GET', url: `/${PATH}/` });
  assert.equal(page.statusCode, 200);
  assert.match(page.headers['content-type'], /text\/html/);
  assert.match(page.headers['content-security-policy'], /default-src 'none'/);
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.equal(page.body.includes('segredo-do-admin'), false);
  assert.equal(page.body.includes(PATH), false); // not even the secret address shows inside the page
  assert.equal((await app.inject({ method: 'GET', url: `/${PATH}/admin.js` })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: `/${PATH}/admin.css` })).statusCode, 200);
  // the paths an attacker tries first do not exist
  for (const guess of ['/admin', '/admin/', '/admin/api/state', '/administrator', '/painel', '/manage', '/dashboard', '/admin.js']) {
    assert.equal((await app.inject({ method: 'GET', url: guess, headers: ADMIN })).statusCode, 404, guess);
  }
  await app.close();
});

test('without ADMIN_TOKEN, without ADMIN_PATH or with a short/invalid ADMIN_PATH there is no administration', async () => {
  for (const config of [{ adminToken: '' }, { adminPath: '' }, { adminPath: 'admin' }, { adminPath: 'curto-demais' }, { adminPath: 'tem espaco e passa de dezesseis' }]) {
    const { app } = await build({ config });
    const path = config.adminPath || PATH;
    assert.equal((await app.inject({ method: 'GET', url: `/${path}/` })).statusCode, 404, JSON.stringify(config));
    assert.equal((await app.inject({ method: 'GET', url: `/${path}/api/state`, headers: ADMIN })).statusCode, 404, JSON.stringify(config));
    await app.close();
  }
});

test("the environment's ADMIN_PATH counts only with 16 to 64 letters, digits, _ or -", async () => {
  const { loadConfig } = await import('../dist/config.js');
  assert.equal(loadConfig({ ADMIN_PATH: 'gestao-secreta-9f3k2x7q1m4z8p5a' }).adminPath, 'gestao-secreta-9f3k2x7q1m4z8p5a');
  for (const bad of ['', 'admin', 'a'.repeat(15), 'a'.repeat(65), 'com/barra/barra/barra', '../../etc/passwd-passwd', 'com espaço no meio....']) assert.equal(loadConfig({ ADMIN_PATH: bad }).adminPath, '', bad);
  assert.equal(loadConfig({}).adminPath, '');
});

test('the API refuses without the token or with a wrong one, and locks out whoever insists', async () => {
  const { app } = await build({ rateLimits: { adminFail: { max: 3, windowMs: 600_000 } } });
  assert.equal((await app.inject({ method: 'GET', url: `/${PATH}/api/state` })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: `/${PATH}/api/state`, headers: { 'x-admin-token': 'errado' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'PUT', url: `/${PATH}/api/emails`, payload: { email: 'a@b.com', can_pair: true, can_cloud: true } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: `/${PATH}/api/state`, headers: { 'x-admin-token': 'errado' } })).statusCode, 429); // past the error quota
  assert.equal((await admin(app, 'GET', '/state')).statusCode, 200); // whoever has the right token is not affected
  await app.close();
});

test('e-mails: created, changed, validated and removed; and the effect is immediate (no restart)', async () => {
  const { app, sent } = await build();
  assert.equal((await app.inject({ method: 'POST', url: '/agent/v1/pair/request', payload: { email: 'ana@exemplo.com' } })).statusCode, 503); // nobody authorized yet

  assert.equal((await admin(app, 'PUT', '/emails', { email: ' Ana@Exemplo.com ', can_pair: true, can_cloud: false })).statusCode, 200);
  assert.equal((await admin(app, 'PUT', '/emails', { email: 'lixo', can_pair: true, can_cloud: false })).statusCode, 400);
  assert.equal((await admin(app, 'PUT', '/emails', { email: '*', can_pair: true, can_cloud: true })).statusCode, 400); // the asterisk never sends songs
  const state = (await admin(app, 'GET', '/state')).json();
  assert.deepEqual(state.emails.rules, [{ email: 'ana@exemplo.com', can_pair: true, can_cloud: false }]);

  const ana = await pairByEmail(app, sent, 'ana@exemplo.com');
  assert.equal((await app.inject({ method: 'GET', url: '/agent/v1/me', headers: ana.headers })).json().cloud, false);
  await admin(app, 'PUT', '/emails', { email: 'ana@exemplo.com', can_pair: true, can_cloud: true }); // now it sends too
  assert.equal((await app.inject({ method: 'GET', url: '/agent/v1/me', headers: ana.headers })).json().cloud, true); // it applies at once
  await uploadSong(app, ana);

  const before = sent.length;
  await app.inject({ method: 'POST', url: '/agent/v1/pair/request', payload: { email: 'intruso@exemplo.com' } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sent.length, before); // not on the list: nothing is sent

  assert.equal((await admin(app, 'PUT', '/emails', { email: 'ana@exemplo.com', can_pair: false, can_cloud: false })).json().removed, true); // without permissions it goes away
  assert.equal((await app.inject({ method: 'GET', url: '/agent/v1/me', headers: ana.headers })).json().cloud, false); // and it stops sending
  assert.equal((await put(app, ana, SONG, 'lyrics.json', Buffer.from('[]'))).statusCode, 403);
  assert.equal((await admin(app, 'DELETE', '/emails/nao%40existe.com')).statusCode, 404);
  await app.close();
});

test("the asterisk on the page lets any e-mail get the code; the .env's lists add up and show as fixed", async () => {
  const { app, sent } = await build({ config: { pairAllowedEmails: ['fixo@exemplo.com'], cloudUploadEmails: ['dono@exemplo.com'] } });
  await admin(app, 'PUT', '/emails', { email: '*', can_pair: true, can_cloud: false });
  const before = sent.length;
  await app.inject({ method: 'POST', url: '/agent/v1/pair/request', payload: { email: 'qualquer@exemplo.com' } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sent.length, before + 1);
  const state = (await admin(app, 'GET', '/state')).json();
  assert.deepEqual(state.emails.fixed, { pair: ['fixo@exemplo.com'], cloud: ['dono@exemplo.com'] });
  assert.equal(state.mail.enabled, true);
  await app.close();
});

test('computers: listed with their e-mail and permission, and disconnecting cuts their access', async () => {
  const { app, sent } = await build();
  await admin(app, 'PUT', '/emails', { email: 'bia@exemplo.com', can_pair: true, can_cloud: true });
  const bia = await pairByEmail(app, sent, 'bia@exemplo.com');
  const state = (await admin(app, 'GET', '/state')).json();
  const device = state.devices.find((d) => d.id === bia.id);
  assert.equal(device.email, 'bia@exemplo.com');
  assert.equal(device.cloud, true);
  assert.equal(device.revoked, false);
  assert.equal(JSON.stringify(state).includes('sga_'), false); // no token leaks
  assert.equal((await admin(app, 'DELETE', `/devices/${bia.id}`)).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/agent/v1/me', headers: bia.headers })).statusCode, 401);
  assert.equal((await admin(app, 'GET', '/state')).json().devices.find((d) => d.id === bia.id).revoked, true);
  assert.equal((await admin(app, 'DELETE', '/devices/inexistente')).statusCode, 404);
  await app.close();
});

test('songs in the cloud: they show on the page; removing deletes and blocks a resend, and unblocking allows it again', async () => {
  const { app, sent } = await build();
  await admin(app, 'PUT', '/emails', { email: 'dono@exemplo.com', can_pair: true, can_cloud: true });
  const owner = await pairByEmail(app, sent, 'dono@exemplo.com');
  await uploadSong(app, owner);

  let state = (await admin(app, 'GET', '/state')).json();
  assert.equal(state.cloud.length, 1);
  assert.equal(state.cloud[0].title, 'Tempo Perdido');
  assert.equal(state.cloud[0].artist, 'Legião Urbana');
  assert.ok(state.cloud_total > 300);
  assert.equal((await app.inject({ method: 'GET', url: `/media/cache/${SONG}/instrumental.mp3` })).statusCode, 200);

  assert.equal((await admin(app, 'DELETE', `/cloud/${SONG}`)).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: `/media/cache/${SONG}/instrumental.mp3` })).statusCode, 404);
  state = (await admin(app, 'GET', '/state')).json();
  assert.deepEqual([state.cloud.length, state.blocked.map((b) => b.video_id)], [0, [SONG]]);

  // the owner's computer tries to send it again: refused, and "what is missing" no longer asks for that song
  const again = await put(app, owner, SONG, 'instrumental.mp3', MP3);
  assert.equal(again.statusCode, 403);
  assert.equal(again.json().error, 'cloud_blocked');
  const missing = await app.inject({ method: 'POST', url: '/agent/v1/cloud/missing', headers: owner.headers, payload: { ids: [SONG, 'outraOutra1'] } });
  assert.deepEqual(missing.json().missing, ['outraOutra1']);

  assert.equal((await admin(app, 'POST', `/cloud/${SONG}/unblock`)).statusCode, 200);
  assert.equal((await admin(app, 'POST', `/cloud/${SONG}/unblock`)).statusCode, 404);
  await uploadSong(app, owner);
  assert.equal((await admin(app, 'GET', '/state')).json().cloud.length, 1);
  assert.equal((await admin(app, 'DELETE', '/cloud/..%2F..%2Fetc')).statusCode, 400); // an invalid id
  await app.close();
});

// --- the app's version, managed on the panel: what the server tells the apps and the home page ---
const versionOf = (app, current) => app.inject({ method: 'GET', url: `/agent/v1/version${current ? `?current=${current}` : ''}` }).then((res) => res.json());
const publicConfig = (app) => app.inject({ method: 'GET', url: '/api/config' }).then((res) => res.json());
const RELEASE = { latest: '1.3.0', minimum: '1.1.0', notes: 'Novidades da 1.3.0', url: 'https://github.com/dono/repo/releases/latest' };

test('version: with nothing published the .env applies; publishing on the panel applies at once, for the apps and the home page', async () => {
  const { app } = await build({ config: { appLatestVersion: '1.2.0', appMinVersion: '1.0.0', appNotes: 'do env', appDownloadUrl: 'https://env.example/baixar' } });
  const state = (await admin(app, 'GET', '/state')).json();
  assert.equal(state.release.source, 'env');
  assert.deepEqual([state.release.latest, state.release.notes], ['1.2.0', 'do env']);
  assert.equal((await versionOf(app, '1.1.0')).status, 'update_available');
  assert.equal((await publicConfig(app)).app_latest_version, '1.2.0');

  const saved = await admin(app, 'PUT', '/release', RELEASE);
  assert.equal(saved.statusCode, 200);
  assert.equal(saved.json().release.source, 'panel');
  // the panel takes the .env's place, without a restart
  const answer = await versionOf(app, '1.0.5');
  assert.deepEqual([answer.status, answer.latest, answer.minimum, answer.notes], ['update_required', '1.3.0', '1.1.0', 'Novidades da 1.3.0']);
  assert.equal((await versionOf(app, '1.3.0')).status, 'ok');
  const config = await publicConfig(app);
  assert.deepEqual([config.app_latest_version, config.app_download_url], ['1.3.0', RELEASE.url]);
  assert.equal((await admin(app, 'GET', '/state')).json().release.env.latest, '1.2.0'); // what the .env would say once cleared

  // clearing goes back to the .env
  const cleared = await admin(app, 'DELETE', '/release');
  assert.equal(cleared.json().removed, true);
  assert.equal(cleared.json().release.source, 'env');
  assert.equal((await versionOf(app, '1.1.0')).latest, '1.2.0');
  assert.equal((await admin(app, 'DELETE', '/release')).json().removed, false); // it was already clear
  await app.close();
});

test('version: with neither the .env nor the panel there is no notice; only the panel can publish (token), and the data is validated', async () => {
  const { app } = await build();
  assert.equal((await admin(app, 'GET', '/state')).json().release.source, 'none');
  assert.equal((await versionOf(app, '1.0.0')).status, 'unknown');
  assert.equal((await publicConfig(app)).app_latest_version, null);

  const anon = await app.inject({ method: 'PUT', url: `/${PATH}/api/release`, payload: RELEASE });
  assert.equal(anon.statusCode, 403);
  assert.equal((await versionOf(app, '1.0.0')).status, 'unknown'); // nothing changed

  const bad = async (patch) => (await admin(app, 'PUT', '/release', { ...RELEASE, ...patch })).statusCode;
  assert.equal(await bad({ latest: 'abc' }), 400);
  assert.equal(await bad({ minimum: '1.2' }), 400);
  assert.equal(await bad({ latest: '1.0.0', minimum: '2.0.0' }), 400); // the minimum above the latest
  assert.equal(await bad({ url: 'javascript:alert(1)' }), 400);
  assert.equal(await bad({ url: 'ftp://x.example/a' }), 400);
  assert.equal(await bad({ notes: 'x'.repeat(501) }), 400);
  assert.equal(await bad({ notes: 'x'.repeat(1001) }), 400);
  assert.equal((await admin(app, 'PUT', '/release', { latest: '1.0.0' })).statusCode, 400); // missing fields
  assert.equal(await bad({ minimum: '', url: '', notes: '' }), 200); // the latest alone is enough
  assert.equal(await bad({ latest: '', minimum: '1.0.0', url: '', notes: '' }), 200); // or the minimum alone
  const message = (await admin(app, 'PUT', '/release', { ...RELEASE, latest: 'x' })).json();
  assert.match(message.message, /1\.2\.3/); // the error message says the format
  await app.close();
});

test('version: the message is plain text (never HTML), and the address goes to the home page only when it is http/https', async () => {
  const { app } = await build();
  await admin(app, 'PUT', '/release', { ...RELEASE, notes: '  <script>alert(1)</script> Novidades  ' });
  const answer = await versionOf(app, '1.0.0');
  assert.equal(answer.notes, '<script>alert(1)</script> Novidades'); // trimmed; the app shows it as text (textContent)
  await app.close();
});

test('version: each computer shows with the version it reported and whether it is up to date', async () => {
  const { app, sent } = await build({ config: { pairAllowedEmails: ['ana@exemplo.com', 'bia@exemplo.com', 'caio@exemplo.com'] } });
  await admin(app, 'PUT', '/release', { latest: '1.3.0', minimum: '1.2.0', notes: '', url: '' });
  const beat = (agent, version) => app.inject({ method: 'POST', url: '/agent/v1/heartbeat', headers: agent.headers, payload: { version } });
  const ana = await pairByEmail(app, sent, 'ana@exemplo.com');
  const bia = await pairByEmail(app, sent, 'bia@exemplo.com');
  const caio = await pairByEmail(app, sent, 'caio@exemplo.com');
  await beat(ana, '1.3.0'); // up to date
  await beat(bia, '1.2.5'); // a newer one exists
  await beat(caio, '1.1.0'); // below the minimum
  await beat(caio, 'lixo'); // a value that is not a version does not erase what was already known

  const byName = Object.fromEntries((await admin(app, 'GET', '/state')).json().devices.map((d) => [d.name, d]));
  assert.deepEqual([byName['PC ana@exemplo.com'].version, byName['PC ana@exemplo.com'].update_status], ['1.3.0', 'ok']);
  assert.deepEqual([byName['PC bia@exemplo.com'].version, byName['PC bia@exemplo.com'].update_status], ['1.2.5', 'update_available']);
  assert.deepEqual([byName['PC caio@exemplo.com'].version, byName['PC caio@exemplo.com'].update_status], ['1.1.0', 'update_required']);
  // publishing a higher minimum recomputes the state without waiting for the next sign of life
  await admin(app, 'PUT', '/release', { latest: '1.3.0', minimum: '1.3.0', notes: '', url: '' });
  const after = Object.fromEntries((await admin(app, 'GET', '/state')).json().devices.map((d) => [d.name, d.update_status]));
  assert.equal(after['PC bia@exemplo.com'], 'update_required');
  await app.close();
});
