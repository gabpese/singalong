// The same rule as the API (apps/api/src/youtube.js): extracts the 11-character ID from YouTube links.
const ID_RE = /^[A-Za-z0-9_-]{11}$/;
const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);

/** The ID in a YouTube link (or the 11-character ID itself); null if it is not one. */
export function extractVideoId(input: unknown): string | null {
  const text = String(input ?? '').trim();
  if (ID_RE.test(text)) return text;
  let url: URL;
  try {
    url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
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

/** The address of YouTube's embedded player (no tracking cookies) for the video preview. */
export function embedUrl(videoId: string): string {
  return `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&rel=0&playsinline=1`;
}

export const watchUrl = (videoId: string): string => `https://www.youtube.com/watch?v=${videoId}`;

const clean = (value: unknown) => String(value ?? '').replace(/\s+/g, ' ').trim();

/**
 * The YouTube search query from the form's fields, as if the person typed on YouTube itself: "Artist - Song name", or just
 * one of the two (whoever knows the song's name does not need to know whose it is, and vice versa). null if both are empty.
 */
export function buildSearchQuery(artist: unknown, title: unknown): string | null {
  const a = clean(artist);
  const t = clean(title);
  return a && t ? `${a} - ${t}` : a || t || null;
}

// parts between () or [] that only decorate the video's title: "(Official Music Video)", "[OFFICIAL VIDEO]", "(Lyric Video)"
const NOISE_GROUP = /\s*[(\[][^)\]]*\b(?:official|video|audio|lyrics?|visuali[sz]er|hd|4k|mv|clipe|legendado)\b[^)\]]*[)\]]/gi;

/**
 * A guess of the artist and name from a video's title ("Artist - Name (Official Video)"), to prefill the song's confirmation;
 * the person fixes whatever is wrong. Without " - " in the title, everything becomes the name.
 */
export function guessArtistTitle(videoTitle: unknown): { artist: string; title: string } {
  const text = clean(String(videoTitle ?? '').replace(NOISE_GROUP, '').replace(/\s+lyrics?\s*$/i, ''));
  const parts = text.split(/\s[-–—]\s/);
  if (parts.length < 2) return { artist: '', title: text.replace(/^["“”']+|["“”']+$/g, '') };
  const unquote = (value: string) => clean(value).replace(/^["“”']+|["“”']+$/g, '');
  return { artist: unquote(parts[0]), title: unquote(parts.slice(1).join(' - ')) };
}
