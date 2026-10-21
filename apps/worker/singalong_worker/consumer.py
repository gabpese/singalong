"""The worker's main loop: pulls jobs from the server and processes them. The transport (backend.py) is one of two:

  Redis  the classic worker (Docker): reads the "jobs" stream straight from Redis. Contract in apps/api/src/jobs.ts.
  HTTP   the local agent: only outgoing connections to the server's /agent/v1 (AGENT_URL + AGENT_TOKEN), no access to Redis.

The worker always PULLS work (the API never calls it), so it can run behind NAT / on another machine.
Each job's handling (retries, errors, loop protection) is in runner.py.
"""
import logging
import os
import signal
import socket
import threading
import time
from urllib.parse import urlsplit

from .backend import AuthError, BackendUnavailable, HttpBackend, make_backend
from .cookies import as_policy
from .cloud import serve as cloud_serve
from .backing import serve as backing_serve
from .export import serve as export_serve
from .key import backfill as key_backfill
from .logsetup import setup_logging
from .media_server import MediaServer
from .runner import Settings, handle
from .search import serve as search_serve
from .storage import LocalStorage
from .titles import backfill as titles_backfill

log = logging.getLogger("worker")

HEARTBEAT_EVERY = 10  # seconds
SERVER_HEARTBEAT_EVERY = 15  # the server considers the owner offline after 45 s without a heartbeat


def _heartbeat(path, backend, stop: threading.Event) -> None:
    """Marks the worker as alive, even during a job that takes minutes: the file (Docker's healthcheck reads its date) and,
    in the local agent, the heartbeat to the server (otherwise the Room would show the owner offline in the middle of a job)."""
    last_server = 0.0
    while not stop.is_set():
        try:
            path.touch()
        except OSError:
            pass
        if time.monotonic() - last_server >= SERVER_HEARTBEAT_EVERY:
            last_server = time.monotonic()
            try:
                backend.heartbeat()
            except (BackendUnavailable, AuthError) as exc:
                log.warning("sem sinal de vida para o servidor: %s", exc)
        stop.wait(HEARTBEAT_EVERY)


def _start_media_server(settings: Settings, storage_root, backend):
    """Starts the local media server and tells the backend the address the browser must use. None if it does not apply."""
    if not isinstance(backend, HttpBackend) or settings.media_port == 0:
        return None  # the classic worker and the agent with AGENT_MEDIA_PORT=0 use the server's storage
    page = urlsplit(settings.agent_url or "")
    origins = sorted({f"{page.scheme}://{page.netloc}", *settings.allowed_origins})
    last_error = None
    # with the fixed "public" port (Docker) the port cannot change; otherwise it tries the next ones if the first is taken
    for port in ([settings.media_port] if settings.media_public else range(settings.media_port, settings.media_port + 10)):
        media = MediaServer(storage_root, origins, port, settings.media_host)
        try:
            local = media.start()
        except OSError as exc:
            last_error = exc
            continue
        if settings.media_host not in ("127.0.0.1", "localhost"):
            log.warning("o servidor local de mídia escuta fora deste computador (%s): só faça isso em Docker ou numa rede de confiança", settings.media_host)
        backend.media_base = f"{settings.media_public}/{media.token}" if settings.media_public else local
        log.info("a TV vai buscar as músicas em %s (origens permitidas: %s)", backend.media_base, ", ".join(origins))
        return media
    log.error("não consegui subir o servidor local de mídia (%s): a nuvem vai usar o armazenamento dela", last_error)
    return None


def run() -> int:
    setup_logging()
    settings = Settings.from_env()
    storage = LocalStorage(settings.storage_root)
    consumer = os.environ.get("WORKER_NAME", socket.gethostname())
    try:
        backend = make_backend(settings.redis_url, consumer, settings.agent_url, settings.agent_token, settings.agent_name)
    except ValueError as exc:
        # AGENT_URL without AGENT_TOKEN: almost always the token's variable is empty in this terminal (in PowerShell, $env: holds per terminal)
        log.error("configuração do agente incompleta: %s. Confira se AGENT_TOKEN tem valor neste terminal.", exc)
        return 2
    policy = as_policy(settings.cookies)
    log.info("cookies do YouTube", extra={"policy": policy.mode, "source": policy.source.describe() if policy.source else None})
    if policy.mode != "never" and policy.source is None:
        log.warning("sem login do YouTube: o agente baixa só sem cookie. Se o YouTube pedir login, rode: python -m singalong_worker --youtube-login")
    media = _start_media_server(settings, settings.storage_root, backend)
    backend.attach_storage(storage)
    stopping = False

    def stop(signum, _frame):
        nonlocal stopping
        stopping = True
        log.info("sinal recebido: terminando o job atual e saindo", extra={"signal": signum})

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    while True:  # waits for the server to become available (compose start order / restarts / network)
        try:
            backend.connect()
            break
        except BackendUnavailable as exc:
            if stopping:
                return 0
            log.warning("servidor indisponível, tentando de novo em 2 s: %s", exc)
            time.sleep(2)
        except AuthError as exc:
            log.error("o servidor recusou o token do agente (revogado?). Pareie de novo: %s", exc)
            return 2

    backend.publish_all()  # local storage: the cloud starts seeing the songs already on this computer
    stop_threads = threading.Event()
    # the YouTube search runs on its own thread: it cannot wait behind a long job (Demucs)
    threading.Thread(target=search_serve, args=(backend.clone(), settings.cookies, stop_threads), name="search", daemon=True).start()
    # the backing vocals take minutes on a CPU: their own thread, one song at a time, without holding the next karaoke song
    threading.Thread(target=backing_serve, args=(backend.clone(), storage, stop_threads), name="backing", daemon=True).start()
    # the MP4 export has its own thread too: it takes a minute and cannot wait behind Demucs
    threading.Thread(target=export_serve, args=(backend.clone(), storage, stop_threads), name="export", daemon=True).start()
    # songs processed before the key feature get their key in the background (once each)
    # (the video title comes first: it is instant, and both updates rewrite the same meta.json, so they do not run together)
    threading.Thread(target=lambda: (titles_backfill(storage), key_backfill(storage)), name="backfill", daemon=True).start()
    # a computer the server allows (ENABLED_TO_SEND_TO_CLOUD): its songs go up to the cloud too, in the background
    threading.Thread(target=cloud_serve, args=(backend.clone(), storage, stop_threads), name="cloud", daemon=True).start()
    threading.Thread(target=_heartbeat, args=(settings.heartbeat_file, backend.clone(), stop_threads), name="heartbeat", daemon=True).start()

    log.info("worker consumindo", extra={"consumer": consumer, "transport": "http" if settings.agent_url else "redis",
                                         "device": settings.device or "auto", "max_duration_s": settings.limits.max_duration,
                                         "min_free_gb": settings.limits.min_free_gb})

    code = 0
    try:
        # 1) what this consumer left pending (a restart in the middle of a job)
        for job in backend.pending():
            if not stopping:
                handle(backend, storage, settings, job)

        last_claim = 0.0
        while not stopping:
            try:
                # 2) jobs abandoned by another worker that went down (no ack for a long time)
                if time.monotonic() - last_claim > 60:
                    last_claim = time.monotonic()
                    for job in backend.reclaim(settings.stale_seconds):
                        if not stopping:
                            handle(backend, storage, settings, job)
                # 3) new jobs
                job = backend.next_job(5)
                if job:
                    handle(backend, storage, settings, job)
            except BackendUnavailable as exc:
                log.warning("conexão com o servidor perdida, tentando de novo em 2 s: %s", exc)
                time.sleep(2)
    except AuthError as exc:
        log.error("o servidor recusou o token do agente (revogado?). Pareie de novo: %s", exc)
        code = 2
    finally:
        stop_threads.set()
        if media:
            media.stop()
        close = getattr(backend, "end_session", None)
        if close and stopping:
            close()  # an exit the owner asked for: ends the session (the pending requests become "the owner left")
    log.info("worker encerrado")
    return code
