// Mesma regra da API (apps/api/src/youtube.js): extrai o ID de 11 caracteres de links do YouTube.
const ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);

/** ID de um link do YouTube (ou o próprio ID de 11 caracteres); null se não for um. */
export function extractVideoId(input) {
  const text = String(input ?? '').trim();
  if (ID_RE.test(text)) return text;
  let url;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
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

/** Endereço do player incorporado do YouTube (modo sem cookies de rastreio) para a prévia do vídeo. */
export function embedUrl(videoId) {
  return `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&rel=0&playsinline=1`;
}

export const watchUrl = (videoId) => `https://www.youtube.com/watch?v=${videoId}`;

/**
 * Consulta da pesquisa no YouTube a partir dos dois campos do formulário: "Artista - Nome da música".
 * null se faltar um dos dois (os dois são obrigatórios: também alimentam a busca da letra).
 */
export function buildSearchQuery(artist, title) {
  const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();
  const a = clean(artist);
  const t = clean(title);
  return a && t ? `${a} - ${t}` : null;
}
