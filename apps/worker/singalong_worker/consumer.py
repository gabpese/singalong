"""Consumidor de jobs sobre Redis Streams. O contrato está documentado em apps/api/src/jobs.js.

O worker sempre PUXA trabalho (nunca é chamado pela API), então pode rodar atrás de NAT / em outra máquina.
"""
import json
import logging
import os
import signal
import socket
import threading
import time
import traceback
from dataclasses import dataclass
from pathlib import Path

import redis

from .key import backfill as key_backfill
from .pipeline import NeedsLyrics, process
from .search import serve as search_serve
from .storage import LocalStorage

STREAM = "jobs"
GROUP = "workers"
log = logging.getLogger("worker")

DONE_TTL = 3600  # status "ready" some do Redis depois de 1 h (a verdade passa a ser o storage)
FAILED_TTL = 86400


@dataclass
class Settings:
    redis_url: str
    storage_root: str
    cookies: Path | None
    device: str | None
    langs: list[str]
    stale_seconds: int
    heartbeat_file: Path

    @classmethod
    def from_env(cls) -> "Settings":
        env = os.environ
        return cls(
            redis_url=env.get("REDIS_URL", "redis://localhost:6379/0"),
            storage_root=env.get("STORAGE_ROOT", "./storage"),
            cookies=Path(env["YTDLP_COOKIES"]) if env.get("YTDLP_COOKIES") else None,
            device=env.get("DEMUCS_DEVICE") or None,
            langs=env.get("LANGS", "pt,en").split(","),
            stale_seconds=int(env.get("WORKER_STALE_SECONDS", "1800")),
            heartbeat_file=Path(env.get("WORKER_HEARTBEAT_FILE", "/tmp/worker-heartbeat")),
        )


def set_job(r: redis.Redis, video_id: str, **fields) -> None:
    key = f"job:{video_id}"
    r.hset(key, mapping={**{k: "" if v is None else str(v) for k, v in fields.items()}, "updated_at": int(time.time() * 1000)})
    status = fields.get("status")
    if status == "ready":
        r.expire(key, DONE_TTL)
    elif status in ("failed", "needs_lyrics"):
        r.expire(key, FAILED_TTL)


def handle(r: redis.Redis, storage: LocalStorage, settings: Settings, msg_id: str, fields: dict) -> None:
    video_id = fields["video_id"]
    payload = json.loads(fields["payload"])
    log.info("job %s: %s (letra: %s)", video_id, payload.get("url"), payload.get("lyrics_source"))
    set_job(r, video_id, status="processing", stage="", error="")
    try:
        process(
            payload["url"],
            storage,
            lyrics_source=payload.get("lyrics_source", "auto"),
            lyrics_text=payload.get("lyrics_text"),
            device=settings.device,
            langs=settings.langs,
            cookies=settings.cookies,
            artist=payload.get("artist"),
            title=payload.get("title"),
            on_stage=lambda stage: set_job(r, video_id, status="processing", stage=stage),
            lyrics_loose=bool(payload.get("lyrics_loose")),
        )
        set_job(r, video_id, status="ready", stage="", error="")
        log.info("job %s: pronto", video_id)
    except (NeedsLyrics, ValueError) as exc:
        # depende de uma decisão do usuário (escolher/corrigir a fonte da letra), não é falha do sistema
        set_job(r, video_id, status="needs_lyrics", stage="", error=str(exc))
        log.info("job %s: precisa de letra (%s)", video_id, exc)
    except Exception as exc:  # noqa: BLE001 - qualquer falha vira status "failed" visível na API
        log.error("job %s falhou:\n%s", video_id, traceback.format_exc())
        set_job(r, video_id, status="failed", stage="", error=f"{type(exc).__name__}: {exc}"[:500])
    finally:
        r.xack(STREAM, GROUP, msg_id)


def _ensure_group(r: redis.Redis) -> None:
    try:
        # id "0": jobs enfileirados antes de o grupo existir não se perdem
        r.xgroup_create(STREAM, GROUP, id="0", mkstream=True)
    except redis.ResponseError as exc:
        if "BUSYGROUP" not in str(exc):
            raise


def _entries(response) -> list[tuple[str, dict]]:
    return [entry for _stream, entries in (response or []) for entry in entries]


def run() -> None:
    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
    settings = Settings.from_env()
    # socket_timeout MAIOR que o block do XREADGROUP (5 s), senão a leitura ociosa estoura o timeout
    r = redis.Redis.from_url(settings.redis_url, decode_responses=True, socket_timeout=30, socket_connect_timeout=5)
    storage = LocalStorage(settings.storage_root)
    consumer = os.environ.get("WORKER_NAME", socket.gethostname())
    stopping = False

    def stop(signum, _frame):
        nonlocal stopping
        stopping = True
        log.info("sinal %s: terminando o job atual e saindo", signum)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    while True:  # espera o Redis ficar disponível (ordem de subida do compose / reinícios)
        try:
            r.ping()
            _ensure_group(r)
            break
        except (redis.ConnectionError, redis.TimeoutError):
            if stopping:
                return
            log.warning("redis indisponível, tentando de novo em 2 s")
            time.sleep(2)

    # a busca no YouTube roda numa thread própria: não pode esperar atrás de um job longo (Demucs)
    stop_search = threading.Event()
    threading.Thread(
        target=search_serve, args=(settings.redis_url, settings.cookies, stop_search), name="search", daemon=True
    ).start()

    # músicas processadas antes do recurso de tom ganham o tom em segundo plano (uma vez cada)
    threading.Thread(target=lambda: key_backfill(storage), name="key-backfill", daemon=True).start()

    log.info("worker %s consumindo '%s' (device=%s)", consumer, STREAM, settings.device or "auto")

    # 1) o que ficou pendente deste consumidor (reinício no meio de um job)
    for msg_id, fields in _entries(r.xreadgroup(GROUP, consumer, {STREAM: "0"}, count=50)):
        if not stopping:
            handle(r, storage, settings, msg_id, fields)

    last_claim = 0.0
    while not stopping:
        settings.heartbeat_file.touch()
        try:
            # 2) jobs abandonados por outro worker que caiu (sem ack há muito tempo)
            if time.monotonic() - last_claim > 60:
                last_claim = time.monotonic()
                claimed = r.xautoclaim(STREAM, GROUP, consumer, min_idle_time=settings.stale_seconds * 1000, start_id="0-0", count=10)
                for msg_id, fields in claimed[1]:
                    if fields and not stopping:
                        handle(r, storage, settings, msg_id, fields)
            # 3) novos jobs
            for msg_id, fields in _entries(r.xreadgroup(GROUP, consumer, {STREAM: ">"}, count=1, block=5000)):
                handle(r, storage, settings, msg_id, fields)
        except (redis.ConnectionError, redis.TimeoutError):
            log.warning("conexão com o redis perdida, tentando de novo em 2 s")
            time.sleep(2)
    stop_search.set()
    log.info("worker encerrado")
