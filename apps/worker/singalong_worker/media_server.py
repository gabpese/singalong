"""The agent's local media server: serves the songs on the owner's computer to the TV's browser.

The karaoke page comes from the cloud (https://...) and loads the audio and the lyrics from `http://127.0.0.1:<port>/<token>/cache/<id>/<file>`.
The browser (Chrome/Edge) asks the user for the "Local network access" permission the first time; with it, what the player
uses works: fetch, <audio crossOrigin>, Web Audio and seeking in the audio (Range requests). See TRD, section 5.

Security: it serves only a fixed list of files (never the isolated vocals, source.json or meta.json), with the song's id
validated; the path carries a random token per run; it answers with CORS only to the page's origin (the cloud's); only GET,
HEAD and OPTIONS; no folder listing. It listens on 127.0.0.1 (this computer only).
"""
import logging
import re
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, unquote, urlsplit

log = logging.getLogger("worker.media")

SERVED = re.compile(r"^(instrumental\.mp3|lyrics\.json|melody\.json|backing\.mp3|vocals\.mp3|karaoke(_p[+-][1-6])?\.mp4)$")
VIDEO_ID = re.compile(r"^([A-Za-z0-9_-]{11}|f-[0-9a-f]{12})$")
CONTENT_TYPES = {".mp3": "audio/mpeg", ".json": "application/json; charset=utf-8", ".mp4": "video/mp4"}
CHUNK = 64 * 1024
BAD_NAME_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]')


def download_name(raw: str | None) -> str | None:
    """The suggested download name (?download=...), without characters that file systems refuse; None if empty."""
    name = re.sub(r"\s+", " ", BAD_NAME_CHARS.sub(" ", raw or "")).strip()[:120]
    return name or None


def parse_range(header: str | None, size: int) -> tuple[int, int] | None | str:
    """The requested range: (start, end) including the end; None if there is no Range; "invalid" if it cannot be served (416)."""
    if not header:
        return None
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", header.strip())
    if not match or (not match.group(1) and not match.group(2)):
        return "invalid"
    if match.group(1):
        start = int(match.group(1))
        end = int(match.group(2)) if match.group(2) else size - 1
    else:  # "bytes=-N": the last N bytes
        length = int(match.group(2))
        if length == 0:
            return "invalid"
        start, end = max(size - length, 0), size - 1
    if start >= size or start > end:
        return "invalid"
    return start, min(end, size - 1)


class MediaServer:
    def __init__(self, storage_root, allowed_origins: list[str], port: int = 8765, host: str = "127.0.0.1", token: str | None = None):
        self.root = Path(storage_root).resolve()
        self.allowed = {origin.rstrip("/") for origin in allowed_origins if origin}
        self.host, self.requested_port = host, port
        self.token = token or secrets.token_urlsafe(12)
        self._httpd: ThreadingHTTPServer | None = None
        self.port: int | None = None

    @property
    def local_base(self) -> str:
        return f"http://127.0.0.1:{self.port}/{self.token}"

    def start(self) -> str:
        """Starts the server on a thread and returns the address (with the token) the browser must use."""
        server = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"
            server_version = "singalong-media"
            sys_version = ""

            def log_message(self, fmt, *args):  # noqa: A003 - API do http.server
                log.debug("%s %s", self.address_string(), fmt % args)

            def do_GET(self):  # noqa: N802
                server._serve(self, send_body=True)

            def do_HEAD(self):  # noqa: N802
                server._serve(self, send_body=False)

            def do_OPTIONS(self):  # noqa: N802
                server._preflight(self)

            def _method_not_allowed(self):
                server._reply(self, 405, {"Allow": "GET, HEAD, OPTIONS"})

            do_POST = do_PUT = do_DELETE = do_PATCH = _method_not_allowed  # noqa: N815

        class Server(ThreadingHTTPServer):
            daemon_threads = True
            allow_reuse_address = True

        self._httpd = Server((self.host, self.requested_port), Handler)
        self.port = self._httpd.server_address[1]
        threading.Thread(target=lambda: self._httpd.serve_forever(poll_interval=0.05), name="media-server", daemon=True).start()
        log.info("servidor local de mídia no ar", extra={"host": self.host, "port": self.port})
        return self.local_base

    def stop(self) -> None:
        if self._httpd:
            self._httpd.shutdown()
            self._httpd.server_close()
            self._httpd = None

    # --- CORS ---
    def _cors(self, handler) -> dict | None:
        """The CORS headers for the request's origin; None if the origin is not the page's (so the request is refused)."""
        origin = handler.headers.get("Origin")
        if origin is None:
            return {}  # direct navigation or <audio> without CORS: no origin to check
        if origin.rstrip("/") not in self.allowed:
            return None
        return {
            "Access-Control-Allow-Origin": origin,
            "Vary": "Origin",
            "Access-Control-Expose-Headers": "Content-Range, Accept-Ranges, Content-Length",
            "Access-Control-Allow-Private-Network": "true",
        }

    def _reply(self, handler, status: int, headers: dict | None = None, body: bytes = b"") -> None:
        handler.send_response(status)
        for name, value in {"Content-Length": str(len(body)), "X-Content-Type-Options": "nosniff", **(headers or {})}.items():
            handler.send_header(name, value)
        handler.end_headers()
        if body and handler.command != "HEAD":
            handler.wfile.write(body)

    def _preflight(self, handler) -> None:
        cors = self._cors(handler)
        if cors is None:
            return self._reply(handler, 403)
        self._reply(handler, 204, {
            **cors, "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS", "Access-Control-Allow-Headers": "range, content-type",
            "Access-Control-Max-Age": "600",
        })

    # --- routes ---
    def _locate(self, raw_path: str) -> Path | str | None:
        """The requested file, "ping" for the probe, or None (does not exist / not allowed)."""
        parts = [unquote(p) for p in urlsplit(raw_path).path.split("/")[1:]]
        if not parts or parts[0] != self.token:
            return None
        rest = parts[1:]
        if rest == ["ping"]:
            return "ping"
        if len(rest) != 3 or rest[0] != "cache" or not VIDEO_ID.fullmatch(rest[1]) or not SERVED.fullmatch(rest[2]):
            return None
        path = (self.root / "cache" / rest[1] / rest[2]).resolve()
        if not path.is_relative_to(self.root) or not path.is_file():
            return None
        return path

    def _serve(self, handler, send_body: bool) -> None:
        cors = self._cors(handler)
        if cors is None:
            return self._reply(handler, 403)
        target = self._locate(handler.path)
        if target is None:
            return self._reply(handler, 404, cors)
        if target == "ping":
            return self._reply(handler, 200, {**cors, "Content-Type": "application/json", "Cache-Control": "no-store"}, b'{"ok":true}')
        size = target.stat().st_size
        byte_range = parse_range(handler.headers.get("Range"), size)
        headers = {**cors, "Content-Type": CONTENT_TYPES.get(target.suffix, "application/octet-stream"), "Accept-Ranges": "bytes",
                   "Cache-Control": "no-cache", "Cross-Origin-Resource-Policy": "cross-origin"}
        name = download_name((parse_qs(urlsplit(handler.path).query).get("download") or [None])[0])
        if name:  # the page is on another origin: the `download` attribute does not apply, so the server itself asks for the download
            headers["Content-Disposition"] = f"attachment; filename*=UTF-8''{quote(name)}"
        if byte_range == "invalid":
            return self._reply(handler, 416, {**cors, "Content-Range": f"bytes */{size}"})
        if byte_range is None:
            status, start, end = 200, 0, size - 1
        else:
            status, (start, end) = 206, byte_range
            headers["Content-Range"] = f"bytes {start}-{end}/{size}"
        length = max(end - start + 1, 0)
        headers["Content-Length"] = str(length)
        handler.send_response(status)
        for name, value in {"X-Content-Type-Options": "nosniff", **headers}.items():
            handler.send_header(name, value)
        handler.end_headers()
        if not send_body:
            return
        try:
            with target.open("rb") as fh:
                fh.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = fh.read(min(CHUNK, remaining))
                    if not chunk:
                        break
                    handler.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass  # the browser closed it (seeked in the audio, changed songs): normal
