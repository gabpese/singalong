"""YouTube video search (yt-dlp), served by a worker thread.

The transport (Redis or HTTP) is in backend.py; the contract with the API is in apps/api/src/jobs.ts.
"""
import logging
import tempfile
import threading
from pathlib import Path

from .cookies import CookiePolicy, as_policy, run_with_policy

log = logging.getLogger("worker.search")

MAX_RESULTS = 8


def search_youtube(query: str, cookies: "CookiePolicy | Path | None" = None, limit: int = MAX_RESULTS) -> list[dict]:
    """Search results, without downloading anything (extract_flat): id, title, channel and duration.

    `cookies`: the cookie policy (cookies.py): no cookie first and, if YouTube asks for a login, with the account.
    """
    import yt_dlp  # a late import, as in the pipeline

    def attempt(cookie_opts: dict) -> list[dict]:
        opts = {"quiet": True, "no_warnings": True, "skip_download": True, "extract_flat": True, "socket_timeout": 15, **cookie_opts}
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(f"ytsearch{limit}:{query}", download=False)
        return parse_entries(info.get("entries") or [])

    with tempfile.TemporaryDirectory(prefix="singalong-search-") as tmp:
        return run_with_policy(as_policy(cookies), attempt, Path(tmp))


def parse_entries(entries: list) -> list[dict]:
    """Normalizes yt-dlp's entries; drops whatever is not a video with an 11-character ID."""
    results = []
    for entry in entries:
        video_id = (entry or {}).get("id") or ""
        if len(video_id) != 11:
            continue
        results.append(
            {
                "video_id": video_id,
                "title": entry.get("title") or video_id,
                "channel": entry.get("channel") or entry.get("uploader"),
                "duration": entry.get("duration"),
            }
        )
    return results


def serve(backend, cookies: Path | None, stop: threading.Event) -> None:
    """The search thread's loop: answers requests until `stop` is set."""
    from .backend import AuthError, BackendUnavailable  # a late import, like the rest of the transport

    while not stop.is_set():
        try:
            request = backend.next_search(2)
            if not request:
                continue
            try:
                reply = {"results": search_youtube(str(request["q"]), cookies)}
            except Exception as exc:  # noqa: BLE001 - o erro volta para a API em vez de derrubar a thread
                log.warning("busca %r falhou: %s", request.get("q"), exc)
                reply = {"error": f"{type(exc).__name__}: {exc}"[:300]}
            backend.reply_search(str(request["id"]), reply)
        except BackendUnavailable:
            stop.wait(2)
        except AuthError:
            log.error("o servidor recusou o token do agente; a busca parou")
            stop.wait(30)
        except (ValueError, KeyError) as exc:  # a malformed request: drop it
            log.warning("pedido de busca inválido: %s", exc)
