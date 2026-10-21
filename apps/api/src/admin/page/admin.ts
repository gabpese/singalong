// The admin page. No text from the server goes in as HTML (only textContent). The token stays only in this tab (sessionStorage).
import type { AdminState, PublishedRelease, UpdateStatus } from '../../protocol.ts';

const $ = (id: string) => document.getElementById(id)!;
const $input = (id: string) => $(id) as HTMLInputElement;
const $textarea = (id: string) => $(id) as HTMLTextAreaElement;
const KEY = 'singalong-admin-token';
let token = '';
try {
  token = sessionStorage.getItem(KEY) ?? '';
} catch {
  /* sessionStorage blocked: the token lasts until the page reloads */
}

function remember(value: string) {
  token = value;
  try {
    if (value) sessionStorage.setItem(KEY, value);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* ignored */
  }
}

/** An answer the server refused, with its message and HTTP status. */
class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`api${path}`, {
    method,
    headers: { 'x-admin-token': token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = response.status === 204 ? null : await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(data?.message ?? `Erro ${response.status}`, response.status);
  return data as T;
}

const fmtDate = (ms: number | null) => (ms ? new Date(ms).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const fmtSize = (bytes: number) => (bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`);

function cell(content: Node | string) {
  const td = document.createElement('td');
  if (content instanceof Node) td.append(content);
  else td.textContent = content;
  return td;
}

function button(label: string, onClick: () => unknown, className = '') {
  const el = document.createElement('button');
  el.type = 'button';
  el.textContent = label;
  if (className) el.className = className;
  el.addEventListener('click', onClick);
  return el;
}

function checkbox(checked: boolean, onChange: (checked: boolean) => unknown, label: string) {
  const el = document.createElement('input');
  el.type = 'checkbox';
  el.checked = checked;
  el.setAttribute('aria-label', label);
  el.addEventListener('change', () => onChange(el.checked));
  return el;
}

function say(message: string, isError = false) {
  const el = $('status');
  el.textContent = message;
  el.className = isError ? 'error' : 'muted';
}

async function run(action: () => Promise<unknown>, done?: string) {
  try {
    await action();
    if (done) say(done);
  } catch (error) {
    say((error as Error).message, true);
    if (error instanceof ApiError && error.status === 403) logout();
  }
  await load();
}

function rows<T>(table: HTMLElement, items: T[], build: (item: T) => HTMLTableCellElement[], emptyText: string) {
  const body = table.querySelector('tbody')!;
  body.replaceChildren();
  if (items.length === 0) {
    const tr = document.createElement('tr');
    const td = cell(emptyText);
    td.colSpan = 6;
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

// --- the app version: the published one, its message, and who is out of date ---
const STATUS_TEXT: Record<UpdateStatus, string> = { ok: 'em dia', update_available: 'atualização disponível', update_required: 'atualização obrigatória', unknown: 'não informou a versão' };
const SOURCE_TEXT: Record<PublishedRelease['source'], string> = { panel: 'publicada aqui', env: 'vem do .env', none: 'nada publicado' };
let releaseDirty = false; // the person is editing the form: a reload keeps what they typed

function renderPreview() {
  const latest = $input('rel-latest').value.trim();
  const minimum = $input('rel-min').value.trim();
  const notes = $textarea('rel-notes').value.trim() || '(sem mensagem)';
  // the same texts the app shows (apps/desktop/ui/app.ts)
  $('prev-title').textContent = `Há uma versão nova: ${latest || '—'}`;
  $('prev-notes').textContent = notes;
  $('prev-required-box').hidden = !minimum;
  $('prev-required-hint').hidden = !minimum;
  $('prev-required-title').textContent = `Atualização necessária (versão ${minimum} ou mais nova)`;
  $('prev-required-notes').textContent = notes;
  $('rel-count').textContent = `${$textarea('rel-notes').value.length}/500`;
}

function renderRelease(state: AdminState) {
  const release = state.release;
  $('release-source').textContent = SOURCE_TEXT[release.source];
  if (!releaseDirty) {
    $input('rel-latest').value = release.latest;
    $input('rel-min').value = release.minimum;
    $textarea('rel-notes').value = release.notes;
    $input('rel-url').value = release.url;
  }
  $('rel-clear').hidden = release.source !== 'panel';
  $('release-note').textContent = release.source === 'panel' ? `Última publicação: ${fmtDate(release.updated_at)}.` : release.source === 'env' ? 'Estes valores vêm das variáveis APP_* do .env; publicar aqui passa a valer no lugar deles.' : 'Nada configurado: os apps não recebem aviso.';
  renderPreview();

  const active = state.devices.filter((d) => !d.revoked);
  const count = (status: UpdateStatus) => active.filter((d) => d.update_status === status).length;
  $('release-devices').textContent = active.length
    ? `${active.length} computador${active.length === 1 ? '' : 'es'}: ${count('ok')} em dia, ${count('update_available')} com atualização disponível, ${count('update_required')} abaixo da mínima, ${count('unknown')} sem informar a versão.`
    : 'Nenhum computador conectado.';
}

function render(state: AdminState) {
  $('mail-warning').hidden = state.mail.enabled;
  renderRelease(state);

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
    cell(device.revoked ? '' : `${device.version ?? '?'} · ${STATUS_TEXT[device.update_status]}`),
    cell(device.cloud ? 'sim' : 'não'),
    cell(fmtDate(device.last_seen)),
    cell(device.revoked ? '' : button('Desconectar', () => confirm(`Desconectar "${device.name}"? O app dele vai precisar parear de novo.`) && run(() => api('DELETE', `/devices/${device.id}`), 'Computador desconectado.'), 'danger')),
  ], 'Nenhum computador pareado.');

  $('cloud-total').textContent = state.cloud.length ? `(${state.cloud.length} músicas, ${fmtSize(state.cloud_total)})` : '';
  rows($('songs'), state.cloud, (song) => [
    cell(`${song.artist ?? '?'} — ${song.title ?? song.id}`),
    cell(song.origin === 'file' ? 'arquivo do dono' : song.origin.startsWith('url:') ? song.origin.slice(4) : 'YouTube'),
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
    const state = await api<AdminState>('GET', '/state');
    $('login').hidden = true;
    $('panel').hidden = false;
    render(state);
  } catch (error) {
    if (error instanceof ApiError && error.status === 403) logout(error.message);
    else say((error as Error).message, true);
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
  remember($input('token').value.trim());
  $input('token').value = '';
  $('login-error').hidden = true;
  await load();
});

for (const id of ['rel-latest', 'rel-min', 'rel-notes', 'rel-url']) {
  $(id).addEventListener('input', () => {
    releaseDirty = true;
    renderPreview();
  });
}

$('release-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const body = { latest: $input('rel-latest').value.trim(), minimum: $input('rel-min').value.trim(), notes: $textarea('rel-notes').value.trim(), url: $input('rel-url').value.trim() };
  run(() => api('PUT', '/release', body), 'Versão publicada: os apps já recebem o aviso.').then(() => {
    // when the server refused it (the format, a minimum above the latest...), what the person typed stays for them to fix
    if ($('status').className !== 'error') releaseDirty = false;
    return load();
  });
});

$('rel-clear').addEventListener('click', () => {
  if (!confirm('Voltar a usar a versão do .env? O que foi publicado aqui será apagado.')) return;
  releaseDirty = false;
  run(() => api('DELETE', '/release'), 'Voltou a valer o .env.');
});

$('email-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const email = $input('new-email').value.trim();
  if (!email) return;
  run(() => api('PUT', '/emails', { email, can_pair: $input('new-pair').checked, can_cloud: $input('new-cloud').checked }), 'E-mail salvo.').then(() => {
    $input('new-email').value = '';
  });
});

$('logout').addEventListener('click', () => logout());
load();
