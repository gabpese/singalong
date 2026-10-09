"""Consumidor de jobs sobre Redis Streams. O contrato está documentado em apps/api/src/jobs.js.

O worker sempre PUXA trabalho (nunca é chamado pela API), então pode rodar atrás de NAT / em outra máquina.
O tratamento de cada job (retentativas, erros, proteção contra loop) está em runner.py.
"""
import logging
import os
import signal
import socket
import threading
import time

import redis

from .export import serve as export_serve
from .key import backfill as key_backfill
from .titles import backfill as titles_backfill
from .logsetup import setup_logging
from .runner import GROUP, STREAM, Settings, handle
from .search import serve as search_serve
from .storage import LocalStorage

log = logging.getLogger("worker")

HEARTBEAT_EVERY = 10  # segundos


def _ensure_group(r: redis.Redis) -> None:
    try:
        # id "0": jobs enfileirados antes de o grupo existir não se perdem
        r.xgroup_create(STREAM, GROUP, id="0", mkstream=True)
    except redis.ResponseError as exc:
        if "BUSYGROUP" not in str(exc):
            raise


def _entries(response) -> list[tuple[str, dict]]:
    return [entry for _stream, entries in (response or []) for entry in entries]


def _heartbeat(path, stop: threading.Event) -> None:
    """Marca que o worker está vivo, mesmo durante um job de minutos (o healthcheck do Docker lê a data do arquivo)."""
    while not stop.is_set():
        try:
            path.touch()
        except OSError:
            pass
        stop.wait(HEARTBEAT_EVERY)


def run() -> None:
    setup_logging()
    settings = Settings.from_env()
    # socket_timeout MAIOR que o block do XREADGROUP (5 s), senão a leitura ociosa estoura o timeout
    r = redis.Redis.from_url(settings.redis_url, decode_responses=True, socket_timeout=30, socket_connect_timeout=5)
    storage = LocalStorage(settings.storage_root)
    consumer = os.environ.get("WORKER_NAME", socket.gethostname())
    stopping = False

    def stop(signum, _frame):
        nonlocal stopping
        stopping = True
        log.info("sinal recebido: terminando o job atual e saindo", extra={"signal": signum})

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

    stop_threads = threading.Event()
    # a busca no YouTube roda numa thread própria: não pode esperar atrás de um job longo (Demucs)
    threading.Thread(target=search_serve, args=(settings.redis_url, settings.cookies, stop_threads), name="search", daemon=True).start()
    # a exportação em MP4 também tem thread própria: leva um minuto e não pode esperar atrás do Demucs
    threading.Thread(target=export_serve, args=(settings.redis_url, storage, stop_threads), name="export", daemon=True).start()
    # músicas processadas antes do recurso de tom ganham o tom em segundo plano (uma vez cada)
    # (o título do vídeo vem primeiro: é instantâneo e as duas atualizações reescrevem o mesmo meta.json, então não rodam juntas)
    threading.Thread(target=lambda: (titles_backfill(storage), key_backfill(storage)), name="backfill", daemon=True).start()
    threading.Thread(target=_heartbeat, args=(settings.heartbeat_file, stop_threads), name="heartbeat", daemon=True).start()

    log.info("worker consumindo", extra={"consumer": consumer, "stream": STREAM, "device": settings.device or "auto",
                                         "max_duration_s": settings.limits.max_duration, "min_free_gb": settings.limits.min_free_gb})

    # 1) o que ficou pendente deste consumidor (reinício no meio de um job)
    for msg_id, fields in _entries(r.xreadgroup(GROUP, consumer, {STREAM: "0"}, count=50)):
        if not stopping:
            handle(r, storage, settings, msg_id, fields)

    last_claim = 0.0
    while not stopping:
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
    stop_threads.set()
    log.info("worker encerrado")
