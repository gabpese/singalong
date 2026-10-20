"""Busca de vídeos no YouTube (yt-dlp), atendida por uma thread do worker.

O transporte (Redis ou HTTP) está em backend.py; o contrato com a API em apps/api/src/jobs.ts.
"""
import logging
import tempfile
import threading
from pathlib import Path

from .cookies import CookiePolicy, as_policy, run_with_policy

log = logging.getLogger("worker.search")

MAX_RESULTS = 8


def search_youtube(query: str, cookies: "CookiePolicy | Path | None" = None, limit: int = MAX_RESULTS) -> list[dict]:
    """Resultados da busca, sem baixar nada (extract_flat): id, título, canal e duração.

    `cookies`: a política de cookies (cookies.py): sem cookie primeiro e, se o YouTube pedir login, com a conta.
    """
    import yt_dlp  # import tardio, como no pipeline

    def attempt(cookie_opts: dict) -> list[dict]:
        opts = {"quiet": True, "no_warnings": True, "skip_download": True, "extract_flat": True, "socket_timeout": 15, **cookie_opts}
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(f"ytsearch{limit}:{query}", download=False)
        return parse_entries(info.get("entries") or [])

    with tempfile.TemporaryDirectory(prefix="singalong-search-") as tmp:
        return run_with_policy(as_policy(cookies), attempt, Path(tmp))


def parse_entries(entries: list) -> list[dict]:
    """Normaliza as entradas do yt-dlp; descarta o que não é um vídeo com ID de 11 caracteres."""
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
    """Loop da thread de busca: atende pedidos enquanto `stop` não for sinalizado."""
    from .backend import AuthError, BackendUnavailable  # import tardio, como o resto do transporte

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
        except (ValueError, KeyError) as exc:  # pedido malformado: descarta
            log.warning("pedido de busca inválido: %s", exc)
