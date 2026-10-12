// Versão do app instalado × versão publicada: o servidor diz qual é a mais recente, qual é a mínima que ainda aceita e o que mudou.

/** "1.2.3" ou "1.2.3-beta" → [1, 2, 3]; null se não for uma versão. O sufixo depois do "-" é ignorado na comparação. */
export function parseVersion(value) {
  const match = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:[-+][0-9A-Za-z.-]{0,40})?$/.exec(String(value ?? '').trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** <0 se a < b, 0 se iguais, >0 se a > b; null se alguma não for uma versão. */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

/**
 * O que o app instalado precisa saber. `status`: "ok" (em dia), "update_available" (há versão mais nova),
 * "update_required" (abaixo da mínima: o servidor recusa trabalho dele) ou "unknown" (versão desconhecida ou nada configurado).
 */
export function updateInfo(current, { latest = '', minimum = '', notes = '', url = '' } = {}) {
  const info = { latest: parseVersion(latest) ? latest : null, minimum: parseVersion(minimum) ? minimum : null, notes: notes || null, url: url || null };
  let status = 'unknown';
  if (parseVersion(current) && (info.latest || info.minimum)) {
    status = 'ok';
    if (info.latest && compareVersions(current, info.latest) < 0) status = 'update_available';
    if (info.minimum && compareVersions(current, info.minimum) < 0) status = 'update_required';
  }
  return { current: parseVersion(current) ? current : null, status, ...info };
}
