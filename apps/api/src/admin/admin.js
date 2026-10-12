// Página do administrador. Nenhum texto vindo do servidor entra como HTML (só textContent). O token fica só na aba (sessionStorage).
const $ = (id) => document.getElementById(id);
const KEY = 'singalong-admin-token';
let token = '';
try {
  token = sessionStorage.getItem(KEY) ?? '';
} catch {
  /* sessionStorage bloqueado: o token vale só até recarregar */
}

function remember(value) {
  token = value;
  try {
    if (value) sessionStorage.setItem(KEY, value);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* ignora */
  }
}

async function api(method, path, body) {
  const response = await fetch(`/admin/api${path}`, {
    method,
    headers: { 'x-admin-token': token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(data?.message ?? `Erro ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return data;
}

const fmtDate = (ms) => (ms ? new Date(ms).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const fmtSize = (bytes) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`);

function cell(content) {
  const td = document.createElement('td');
  if (content instanceof Node) td.append(content);
  else td.textContent = content ?? '';
  return td;
}

function button(label, onClick, className = '') {
  const el = document.createElement('button');
  el.type = 'button';
  el.textContent = label;
  if (className) el.className = className;
  el.addEventListener('click', onClick);
  return el;
}

function checkbox(checked, onChange, label) {
  const el = document.createElement('input');
  el.type = 'checkbox';
  el.checked = checked;
  el.setAttribute('aria-label', label);
  el.addEventListener('change', () => onChange(el.checked));
  return el;
}

function say(message, isError = false) {
  const el = $('status');
  el.textContent = message;
  el.className = isError ? 'error' : 'muted';
}

async function run(action, done) {
  try {
    await action();
    if (done) say(done);
  } catch (error) {
    say(error.message, true);
    if (error.status === 403) logout();
  }
  await load();
}

function rows(table, items, build, emptyText) {
  const body = table.querySelector('tbody');
  body.replaceChildren();
  if (items.length === 0) {
    const tr = document.createElement('tr');
    const td = cell(emptyText);
    td.colSpan = 5;
    td.className = 'muted';
    tr.append(td);
    body.append(tr);
    return;
  }
  for (const item of items) {
    const tr = document.createElement('tr');
    tr.append(...build(item));
    body.append(tr);
  }
}

function render(state) {
  $('mail-warning').hidden = state.mail.enabled;

  rows($('emails'), state.emails.rules, (rule) => [
    cell(rule.email === '*' ? '* (qualquer e-mail)' : rule.email),
    cell(checkbox(rule.can_pair, (value) => run(() => api('PUT', '/emails', { email: rule.email, can_pair: value, can_cloud: rule.can_cloud })), `${rule.email}: recebe o código`)),
    cell(rule.email === '*' ? '—' : checkbox(rule.can_cloud, (value) => run(() => api('PUT', '/emails', { email: rule.email, can_pair: rule.can_pair, can_cloud: value })), `${rule.email}: envia músicas`)),
    cell(button('Remover', () => confirm(`Remover ${rule.email} da lista?`) && run(() => api('DELETE', `/emails/${encodeURIComponent(rule.email)}`), 'E-mail removido.'), 'danger')),
  ], 'Nenhum e-mail cadastrado aqui.');

  const fixed = [...state.emails.fixed.pair.map((e) => `${e} (recebe o código)`), ...state.emails.fixed.cloud.map((e) => `${e} (envia músicas)`)];
  $('fixed').hidden = fixed.length === 0;
  $('fixed').textContent = fixed.length ? `Também valem estes, definidos no .env do servidor (só mudam lá): ${fixed.join(', ')}.` : '';

  rows($('devices'), state.devices, (device) => [
    cell(device.revoked ? `${device.name} (desconectado)` : device.name),
    cell(device.email ?? '— (pareado sem e-mail)'),
    cell(device.cloud ? 'sim' : 'não'),
    cell(fmtDate(device.last_seen)),
    cell(device.revoked ? '' : button('Desconectar', () => confirm(`Desconectar "${device.name}"? O app dele vai precisar parear de novo.`) && run(() => api('DELETE', `/devices/${device.id}`), 'Computador desconectado.'), 'danger')),
  ], 'Nenhum computador pareado.');

  $('cloud-total').textContent = state.cloud.length ? `(${state.cloud.length} músicas, ${fmtSize(state.cloud_total)})` : '';
  rows($('songs'), state.cloud, (song) => [
    cell(`${song.artist ?? '?'} — ${song.title ?? song.id}`),
    cell(song.origin === 'file' ? 'arquivo do dono' : song.origin?.startsWith('url:') ? song.origin.slice(4) : 'YouTube'),
    cell(fmtSize(song.size)),
    cell(fmtDate(song.updated)),
    cell(button('Remover da nuvem', () => confirm(`Remover "${song.title ?? song.id}" da nuvem e bloquear?`) && run(() => api('DELETE', `/cloud/${song.id}`), 'Música removida e bloqueada.'), 'danger')),
  ], 'Nenhuma música na nuvem ainda.');

  rows($('blocked'), state.blocked, (item) => [
    cell(item.video_id),
    cell(fmtDate(item.blocked_at)),
    cell(button('Liberar', () => run(() => api('POST', `/cloud/${item.video_id}/unblock`), 'Música liberada: poderá ser enviada de novo.'))),
  ], 'Nenhuma bloqueada.');
}

async function load() {
  if (!token) return;
  try {
    const state = await api('GET', '/state');
    $('login').hidden = true;
    $('panel').hidden = false;
    render(state);
  } catch (error) {
    if (error.status === 403) logout(error.message);
    else say(error.message, true);
  }
}

function logout(message = '') {
  remember('');
  $('panel').hidden = true;
  $('login').hidden = false;
  $('login-error').hidden = !message;
  $('login-error').textContent = message;
}

$('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  remember($('token').value.trim());
  $('token').value = '';
  $('login-error').hidden = true;
  await load();
});

$('email-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const email = $('new-email').value.trim();
  if (!email) return;
  run(() => api('PUT', '/emails', { email, can_pair: $('new-pair').checked, can_cloud: $('new-cloud').checked }), 'E-mail salvo.').then(() => {
    $('new-email').value = '';
  });
});

$('logout').addEventListener('click', () => logout());
load();
