// Página e API do administrador: só com o ADMIN_TOKEN; e-mails autorizados, computadores pareados e músicas da nuvem.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildApp } from '../src/app.js';
import { createMemoryJobStore } from '../src/jobs.js';
import { LocalStorage } from '../src/storage.js';

const LOOSE = { max: 1e6, windowMs: 60_000 };
const ADMIN = { 'x-admin-token': 'segredo-do-admin' };
const PATH = 'gestao-secreta-9f3k2x7q1m4z8p5a'; // o endereço secreto da página (ADMIN_PATH)
const SONG = 'abcdefghijk';
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(300, 1)]);
const meta = Buffer.from(JSON.stringify({ video_id: SONG, title: 'Tempo Perdido', artist: 'Legião Urbana' }));

async function build({ config = {}, rateLimits = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'singalong-admin-'));
  const sent = [];
  const app = buildApp({
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

test('a página só existe no endereço SECRETO, não traz o token e tem uma CSP restrita', async () => {
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
  assert.equal(page.body.includes(PATH), false); // nem o endereço secreto aparece dentro da página
  assert.equal((await app.inject({ method: 'GET', url: `/${PATH}/admin.js` })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: `/${PATH}/admin.css` })).statusCode, 200);
  // os caminhos que um atacante tenta primeiro não existem
  for (const guess of ['/admin', '/admin/', '/admin/api/state', '/administrator', '/painel', '/manage', '/dashboard', '/admin.js']) {
    assert.equal((await app.inject({ method: 'GET', url: guess, headers: ADMIN })).statusCode, 404, guess);
  }
  await app.close();
});

test('sem ADMIN_TOKEN, sem ADMIN_PATH ou com um ADMIN_PATH curto/inválido a administração não existe', async () => {
  for (const config of [{ adminToken: '' }, { adminPath: '' }, { adminPath: 'admin' }, { adminPath: 'curto-demais' }, { adminPath: 'tem espaco e passa de dezesseis' }]) {
    const { app } = await build({ config });
    const path = config.adminPath || PATH;
    assert.equal((await app.inject({ method: 'GET', url: `/${path}/` })).statusCode, 404, JSON.stringify(config));
    assert.equal((await app.inject({ method: 'GET', url: `/${path}/api/state`, headers: ADMIN })).statusCode, 404, JSON.stringify(config));
    await app.close();
  }
});

test('o ADMIN_PATH do ambiente só vale com 16 a 64 letras, números, _ ou -', async () => {
  const { loadConfig } = await import('../src/config.js');
  assert.equal(loadConfig({ ADMIN_PATH: 'gestao-secreta-9f3k2x7q1m4z8p5a' }).adminPath, 'gestao-secreta-9f3k2x7q1m4z8p5a');
  for (const bad of ['', 'admin', 'a'.repeat(15), 'a'.repeat(65), 'com/barra/barra/barra', '../../etc/passwd-passwd', 'com espaço no meio....']) assert.equal(loadConfig({ ADMIN_PATH: bad }).adminPath, '', bad);
  assert.equal(loadConfig({}).adminPath, '');
});

test('a API recusa sem o token ou com token errado, e trava quem insiste', async () => {
  const { app } = await build({ rateLimits: { adminFail: { max: 3, windowMs: 600_000 } } });
  assert.equal((await app.inject({ method: 'GET', url: `/${PATH}/api/state` })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: `/${PATH}/api/state`, headers: { 'x-admin-token': 'errado' } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'PUT', url: `/${PATH}/api/emails`, payload: { email: 'a@b.com', can_pair: true, can_cloud: true } })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: `/${PATH}/api/state`, headers: { 'x-admin-token': 'errado' } })).statusCode, 429); // passou da cota de erros
  assert.equal((await admin(app, 'GET', '/state')).statusCode, 200); // quem tem o token certo não é afetado
  await app.close();
});

test('e-mails: cria, altera, valida e remove; e o efeito é imediato (sem reiniciar)', async () => {
  const { app, sent } = await build();
  assert.equal((await app.inject({ method: 'POST', url: '/agent/v1/pair/request', payload: { email: 'ana@exemplo.com' } })).statusCode, 503); // ninguém autorizado ainda

  assert.equal((await admin(app, 'PUT', '/emails', { email: ' Ana@Exemplo.com ', can_pair: true, can_cloud: false })).statusCode, 200);
  assert.equal((await admin(app, 'PUT', '/emails', { email: 'lixo', can_pair: true, can_cloud: false })).statusCode, 400);
  assert.equal((await admin(app, 'PUT', '/emails', { email: '*', can_pair: true, can_cloud: true })).statusCode, 400); // o asterisco nunca envia músicas
  const state = (await admin(app, 'GET', '/state')).json();
  assert.deepEqual(state.emails.rules, [{ email: 'ana@exemplo.com', can_pair: true, can_cloud: false }]);

  const ana = await pairByEmail(app, sent, 'ana@exemplo.com');
  assert.equal((await app.inject({ method: 'GET', url: '/agent/v1/me', headers: ana.headers })).json().cloud, false);
  await admin(app, 'PUT', '/emails', { email: 'ana@exemplo.com', can_pair: true, can_cloud: true }); // agora também envia
  assert.equal((await app.inject({ method: 'GET', url: '/agent/v1/me', headers: ana.headers })).json().cloud, true); // vale na hora
  await uploadSong(app, ana);

  const before = sent.length;
  await app.inject({ method: 'POST', url: '/agent/v1/pair/request', payload: { email: 'intruso@exemplo.com' } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sent.length, before); // fora da lista: nada é enviado

  assert.equal((await admin(app, 'PUT', '/emails', { email: 'ana@exemplo.com', can_pair: false, can_cloud: false })).json().removed, true); // sem permissões some
  assert.equal((await app.inject({ method: 'GET', url: '/agent/v1/me', headers: ana.headers })).json().cloud, false); // e deixa de enviar
  assert.equal((await put(app, ana, SONG, 'lyrics.json', Buffer.from('[]'))).statusCode, 403);
  assert.equal((await admin(app, 'DELETE', '/emails/nao%40existe.com')).statusCode, 404);
  await app.close();
});

test('o asterisco na página libera qualquer e-mail a receber o código; as listas do .env somam e aparecem como fixas', async () => {
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

test('computadores: lista com e-mail e permissão, e desconectar derruba o acesso', async () => {
  const { app, sent } = await build();
  await admin(app, 'PUT', '/emails', { email: 'bia@exemplo.com', can_pair: true, can_cloud: true });
  const bia = await pairByEmail(app, sent, 'bia@exemplo.com');
  const state = (await admin(app, 'GET', '/state')).json();
  const device = state.devices.find((d) => d.id === bia.id);
  assert.equal(device.email, 'bia@exemplo.com');
  assert.equal(device.cloud, true);
  assert.equal(device.revoked, false);
  assert.equal(JSON.stringify(state).includes('sga_'), false); // nenhum token vaza
  assert.equal((await admin(app, 'DELETE', `/devices/${bia.id}`)).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/agent/v1/me', headers: bia.headers })).statusCode, 401);
  assert.equal((await admin(app, 'GET', '/state')).json().devices.find((d) => d.id === bia.id).revoked, true);
  assert.equal((await admin(app, 'DELETE', '/devices/inexistente')).statusCode, 404);
  await app.close();
});

test('músicas da nuvem: aparecem na página; remover apaga, bloqueia o reenvio e liberar permite de novo', async () => {
  const { app, sent } = await build();
  await admin(app, 'PUT', '/emails', { email: 'dono@exemplo.com', can_pair: true, can_cloud: true });
  const dono = await pairByEmail(app, sent, 'dono@exemplo.com');
  await uploadSong(app, dono);

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

  // o computador do dono tenta enviar de novo: recusado, e o "o que falta" não pede mais essa música
  const again = await put(app, dono, SONG, 'instrumental.mp3', MP3);
  assert.equal(again.statusCode, 403);
  assert.equal(again.json().error, 'cloud_blocked');
  const missing = await app.inject({ method: 'POST', url: '/agent/v1/cloud/missing', headers: dono.headers, payload: { ids: [SONG, 'outraOutra1'] } });
  assert.deepEqual(missing.json().missing, ['outraOutra1']);

  assert.equal((await admin(app, 'POST', `/cloud/${SONG}/unblock`)).statusCode, 200);
  assert.equal((await admin(app, 'POST', `/cloud/${SONG}/unblock`)).statusCode, 404);
  await uploadSong(app, dono);
  assert.equal((await admin(app, 'GET', '/state')).json().cloud.length, 1);
  assert.equal((await admin(app, 'DELETE', '/cloud/..%2F..%2Fetc')).statusCode, 400); // id inválido
  await app.close();
});
