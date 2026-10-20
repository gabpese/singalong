// Pareamento por e-mail: o código só sai para e-mails autorizados, a resposta nunca revela quem está na lista e há limites.
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildApp } from '../dist/app.js';
import { createMemoryJobStore } from '../dist/jobs.js';
import { createMailer, pairingEmail } from '../dist/mailer.js';
import { LocalStorage } from '../dist/storage.js';

const LOOSE = { max: 1e6, windowMs: 60_000 };

async function build({ allowed = ['ana@exemplo.com'], enabled = true, rateLimits = {}, mailer } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'singalong-mail-'));
  const sent = [];
  const app = await buildApp({
    config: { publicDir: root, adminToken: 'adm', pairAllowedEmails: allowed, publicUrl: 'https://karaoke.exemplo', rateLimits: { pair: LOOSE, pairRequest: LOOSE, pairEmail: LOOSE, ...rateLimits } },
    storage: new LocalStorage(root),
    jobs: createMemoryJobStore(),
    mailer: mailer ?? { enabled, send: async (message) => { sent.push(message); } },
  });
  await app.ready();
  return { app, sent };
}

const ask = (app, email) => app.inject({ method: 'POST', url: '/agent/v1/pair/request', payload: { email } });
const settle = () => new Promise((resolve) => setTimeout(resolve, 20)); // o envio roda em segundo plano

test('e-mail autorizado recebe um código que de fato pareia', async () => {
  const { app, sent } = await build();
  const res = await ask(app, 'ana@exemplo.com');
  assert.equal(res.statusCode, 202);
  await settle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'ana@exemplo.com');
  const code = /código[^:]*: ([A-Z0-9]{8})/.exec(sent[0].text)[1];
  assert.match(sent[0].subject, new RegExp(code));
  assert.match(sent[0].text, /10 minutos/);
  assert.match(sent[0].text, /karaoke\.exemplo/);
  const done = await app.inject({ method: 'POST', url: '/agent/v1/pair/complete', payload: { code, name: 'PC da Ana' } });
  assert.equal(done.statusCode, 201);
  assert.ok(done.json().token);
  const again = await app.inject({ method: 'POST', url: '/agent/v1/pair/complete', payload: { code, name: 'PC' } });
  assert.equal(again.statusCode, 400); // o código é de uso único
  await app.close();
});

test('com asterisco na lista qualquer e-mail recebe o código (os limites continuam)', async () => {
  const { app, sent } = await build({ allowed: ['*'] });
  assert.equal((await ask(app, 'qualquer@exemplo.com')).statusCode, 202);
  assert.equal((await ask(app, 'outra@exemplo.org')).statusCode, 202);
  await settle();
  assert.deepEqual(sent.map((m) => m.to), ['qualquer@exemplo.com', 'outra@exemplo.org']);
  const limited = await build({ allowed: ['*'], rateLimits: { pairEmail: { max: 1, windowMs: 3_600_000 } } });
  await ask(limited.app, 'a@exemplo.com');
  await ask(limited.app, 'a@exemplo.com');
  await settle();
  assert.equal(limited.sent.length, 1); // o limite por endereço vale também com asterisco
  await app.close();
  await limited.app.close();
});

test('maiúsculas e espaços no e-mail não atrapalham', async () => {
  const { app, sent } = await build();
  assert.equal((await ask(app, '  Ana@Exemplo.COM ')).statusCode, 202);
  await settle();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'ana@exemplo.com');
  await app.close();
});

test('e-mail fora da lista recebe a MESMA resposta, mas nada é enviado', async () => {
  const { app, sent } = await build();
  const allowed = await ask(app, 'ana@exemplo.com');
  const stranger = await ask(app, 'intruso@exemplo.com');
  await settle();
  assert.equal(stranger.statusCode, 202);
  assert.deepEqual(stranger.json(), allowed.json());
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'ana@exemplo.com');
  await app.close();
});

test('e-mail malformado é recusado; servidor sem e-mail configurado responde 503', async () => {
  const { app } = await build();
  for (const bad of ['lixo', 'a@b', '@x.com', 'a b@c.com', '']) assert.equal((await ask(app, bad)).statusCode, 400, bad);
  assert.equal((await app.inject({ method: 'POST', url: '/agent/v1/pair/request', payload: {} })).statusCode, 400);
  await app.close();

  for (const options of [{ enabled: false }, { allowed: [] }]) {
    const { app: off } = await build(options);
    const res = await ask(off, 'ana@exemplo.com');
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error, 'email_disabled');
    await off.close();
  }
});

test('limites: poucos pedidos por e-mail por hora e por IP; passou do limite, nenhum e-mail sai', async () => {
  const perEmail = await build({ rateLimits: { pairEmail: { max: 2, windowMs: 3_600_000 } } });
  for (let i = 0; i < 5; i++) assert.equal((await ask(perEmail.app, 'ana@exemplo.com')).statusCode, 202); // a resposta não muda
  await settle();
  assert.equal(perEmail.sent.length, 2); // mas só 2 mensagens saíram
  await perEmail.app.close();

  const perIp = await build({ rateLimits: { pairRequest: { max: 3, windowMs: 600_000 } } });
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await ask(perIp.app, `x${i}@exemplo.com`)).statusCode);
  assert.deepEqual(codes, [202, 202, 202, 429, 429]);
  await perIp.app.close();
});

test('uma falha do serviço de e-mail não derruba o pedido nem mostra o motivo', async () => {
  const { app } = await build({ mailer: { enabled: true, send: async () => { throw new Error('Brevo fora do ar'); } } });
  const res = await ask(app, 'ana@exemplo.com');
  assert.equal(res.statusCode, 202);
  assert.equal(JSON.stringify(res.json()).includes('Brevo'), false);
  await settle();
  await app.close();
});

test('o mailer fala com a API do Brevo com a chave e o remetente certos, e recusa se não estiver configurado', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 201 }; };
  const mailer = createMailer({ apiKey: 'chave-secreta', fromEmail: 'karaoke@exemplo.com', fromName: 'Singalong', fetchImpl });
  assert.equal(mailer.enabled, true);
  await mailer.send({ to: 'ana@exemplo.com', subject: 'Oi', text: 'Corpo' });
  assert.equal(calls[0].url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(calls[0].init.headers['api-key'], 'chave-secreta');
  const body = JSON.parse(calls[0].init.body);
  assert.deepEqual(body.sender, { email: 'karaoke@exemplo.com', name: 'Singalong' });
  assert.deepEqual(body.to, [{ email: 'ana@exemplo.com' }]);
  assert.equal(body.textContent, 'Corpo');

  const refused = createMailer({ apiKey: 'k', fromEmail: 'a@b.com', fetchImpl: async () => ({ ok: false, status: 401 }) });
  await assert.rejects(refused.send({ to: 'x@y.com', subject: 's', text: 't' }), /401/);
  const off = createMailer({});
  assert.equal(off.enabled, false);
  await assert.rejects(off.send({ to: 'x@y.com', subject: 's', text: 't' }), /não está configurado/);
});

test('o texto do e-mail tem o código, o prazo e nenhum link', () => {
  const { subject, text } = pairingEmail({ code: 'ABCD2345', minutes: 10, server: 'https://x.org' });
  assert.match(subject, /ABCD2345/);
  assert.match(text, /10 minutos/);
  assert.equal(/https?:\/\/(?!x\.org)/.test(text), false);
});
