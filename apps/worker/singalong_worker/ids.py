import re
from urllib.parse import parse_qs, urlparse

_ID_RE = re.compile(r"^[A-Za-z0-9_-]{11}$")
_YT_HOSTS = {"youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"}


def extract_video_id(url: str) -> str | None:
    """Extrai o ID de 11 caracteres de links do YouTube; aceita também o ID puro."""
    url = url.strip()
    if _ID_RE.match(url):
        return url
    parsed = urlparse(url)
    host = (parsed.hostname or "").lower()
    candidate = None
    if host == "youtu.be":
        candidate = parsed.path.lstrip("/").split("/")[0]
    elif host in _YT_HOSTS:
        if parsed.path == "/watch":
            candidate = (parse_qs(parsed.query).get("v") or [None])[0]
        else:
            m = re.match(r"^/(?:shorts|embed|live|v)/([^/?]+)", parsed.path)
            candidate = m.group(1) if m else None
    return candidate if candidate and _ID_RE.match(candidate) else None
