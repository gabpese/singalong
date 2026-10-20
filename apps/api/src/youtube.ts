const ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);

/** The 11-character id of a YouTube link; a bare id is taken too. null when invalid. */
export function extractVideoId(input: unknown): string | null {
  const text = String(input ?? '').trim();
  if (ID_RE.test(text)) return text;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  let candidate: string | null = null;
  if (host === 'youtu.be') {
    candidate = url.pathname.replace(/^\/+/, '').split('/')[0];
  } else if (YT_HOSTS.has(host)) {
    if (url.pathname === '/watch') candidate = url.searchParams.get('v');
    else candidate = /^\/(?:shorts|embed|live|v)\/([^/?]+)/.exec(url.pathname)?.[1] ?? null;
  }
  return candidate && ID_RE.test(candidate) ? candidate : null;
}
