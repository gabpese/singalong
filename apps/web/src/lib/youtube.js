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

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

/**
 * Consulta da pesquisa no YouTube a partir dos campos do formulário, como se a pessoa digitasse no próprio YouTube:
 * "Artista - Nome da música", ou só um dos dois (quem sabe o nome da música não precisa saber de quem é, e vice-versa).
 * null se os dois estiverem vazios.
 */
export function buildSearchQuery(artist, title) {
  const a = clean(artist);
  const t = clean(title);
  return a && t ? `${a} - ${t}` : a || t || null;
}

// trechos entre () ou [] que são só enfeite do título do vídeo: "(Official Music Video)", "[OFFICIAL VIDEO]", "(Lyric Video)"
const NOISE_GROUP = /\s*[(\[][^)\]]*\b(?:official|video|audio|lyrics?|visuali[sz]er|hd|4k|mv|clipe|legendado)\b[^)\]]*[)\]]/gi;

/**
 * Palpite de artista e nome a partir do título de um vídeo ("Artista - Nome (Official Video)"), para já preencher a
 * confirmação da música; a pessoa corrige o que estiver errado. Sem " - " no título, tudo vira o nome.
 */
export function guessArtistTitle(videoTitle) {
  const text = clean(String(videoTitle ?? '').replace(NOISE_GROUP, '').replace(/\s+lyrics?\s*$/i, ''));
  const parts = text.split(/\s[-–—]\s/);
  if (parts.length < 2) return { artist: '', title: text.replace(/^["“”']+|["“”']+$/g, '') };
  const unquote = (value) => clean(value).replace(/^["“”']+|["“”']+$/g, '');
  return { artist: unquote(parts[0]), title: unquote(parts.slice(1).join(' - ')) };
}
