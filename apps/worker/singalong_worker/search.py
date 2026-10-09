"""Busca de vídeos no YouTube (yt-dlp), atendida por uma thread do worker.

Contrato com a API (Redis, documentado em apps/api/src/jobs.js):
  lista  "search:req"        a API faz LPUSH de {"id", "q"}
  lista  "search:res:<id>"   o worker responde com LPUSH de {"results": [...]} ou {"error": "..."} (expira em 60 s)
"""
import json
import logging
import shutil
import tempfile
import threading
from pathlib import Path

log = logging.getLogger("worker.search")

REQUEST_KEY = "search:req"
RESULT_TTL = 60
MAX_RESULTS = 8


def search_youtube(query: str, cookies: Path | None = None, limit: int = MAX_RESULTS) -> list[dict]:
    """Resultados da busca, sem baixar nada (extract_flat): id, título, canal e duração."""
    import yt_dlp  # import tardio, como no pipeline

    with tempfile.TemporaryDirectory(prefix="singalong-search-") as tmp:
        opts = {"quiet": True, "no_warnings": True, "skip_download": True, "extract_flat": True, "socket_timeout": 15}
        if cookies:
            cookie_copy = Path(tmp) / "cookies.txt"
            shutil.copyfile(cookies, cookie_copy)
            opts["cookiefile"] = str(cookie_copy)
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(f"ytsearch{limit}:{query}", download=False)
    return parse_entries(info.get("entries") or [])


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


def serve(redis_url: str, cookies: Path | None, stop: threading.Event) -> None:
    """Loop da thread de busca: atende pedidos enquanto `stop` não for sinalizado."""
    import redis  # import tardio: os testes de parse_entries não precisam do cliente Redis

    r = redis.Redis.from_url(redis_url, decode_responses=True, socket_timeout=30, socket_connect_timeout=5)
    while not stop.is_set():
        try:
            item = r.brpop(REQUEST_KEY, timeout=2)
            if not item:
                continue
            request = json.loads(item[1])
            try:
                reply = {"results": search_youtube(str(request["q"]), cookies)}
            except Exception as exc:  # noqa: BLE001 - o erro volta para a API em vez de derrubar a thread
                log.warning("busca %r falhou: %s", request.get("q"), exc)
                reply = {"error": f"{type(exc).__name__}: {exc}"[:300]}
            key = f"search:res:{request['id']}"
            r.lpush(key, json.dumps(reply, ensure_ascii=False))
            r.expire(key, RESULT_TTL)
        except (redis.ConnectionError, redis.TimeoutError):
            stop.wait(2)
        except (ValueError, KeyError) as exc:  # pedido malformado: descarta
            log.warning("pedido de busca inválido: %s", exc)
