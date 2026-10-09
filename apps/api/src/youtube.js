const ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);

/** Extrai o ID de 11 caracteres de links do YouTube; aceita também o ID puro. null se inválido. */
export function extractVideoId(input) {
  const text = String(input ?? '').trim();
  if (ID_RE.test(text)) return text;
  let url;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  let candidate = null;
  if (host === 'youtu.be') {
    candidate = url.pathname.replace(/^\/+/, '').split('/')[0];
  } else if (YT_HOSTS.has(host)) {
    if (url.pathname === '/watch') candidate = url.searchParams.get('v');
    else candidate = /^\/(?:shorts|embed|live|v)\/([^/?]+)/.exec(url.pathname)?.[1] ?? null;
  }
  return candidate && ID_RE.test(candidate) ? candidate : null;
}
