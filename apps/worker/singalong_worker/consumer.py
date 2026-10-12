"""Loop principal do worker: puxa jobs do servidor e os processa. O transporte (backend.py) é um de dois:

  Redis  o worker clássico (Docker): lê o stream "jobs" direto do Redis. Contrato em apps/api/src/jobs.js.
  HTTP   o agente local: só conexões de saída para /agent/v1 do servidor (AGENT_URL + AGENT_TOKEN), sem acesso ao Redis.

O worker sempre PUXA trabalho (nunca é chamado pela API), então pode rodar atrás de NAT / em outra máquina.
O tratamento de cada job (retentativas, erros, proteção contra loop) está em runner.py.
"""
import logging
import os
import signal
import socket
import threading
import time
from urllib.parse import urlsplit

from .backend import AuthError, BackendUnavailable, HttpBackend, make_backend
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

HEARTBEAT_EVERY = 10  # segundos
SERVER_HEARTBEAT_EVERY = 15  # o servidor considera o dono offline depois de 45 s sem sinal


def _heartbeat(path, backend, stop: threading.Event) -> None:
    """Marca que o worker está vivo, mesmo durante um job de minutos: o arquivo (o healthcheck do Docker lê a data dele) e,
    no agente local, o sinal de vida para o servidor (senão a sala mostraria "dono offline" no meio de um job)."""
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
    """Sobe o servidor local de mídia e diz ao backend o endereço que o navegador deve usar. None se não se aplica."""
    if not isinstance(backend, HttpBackend) or settings.media_port == 0:
        return None  # o worker clássico e o agente com AGENT_MEDIA_PORT=0 usam o armazenamento do servidor
    page = urlsplit(settings.agent_url or "")
    origins = sorted({f"{page.scheme}://{page.netloc}", *settings.allowed_origins})
    last_error = None
    # com a porta "pública" fixa (Docker) não dá para trocar de porta; fora disso tenta as seguintes se a primeira estiver ocupada
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
        # AGENT_URL sem AGENT_TOKEN: quase sempre a variável do token está vazia neste terminal (no PowerShell, $env: vale só por terminal)
        log.error("configuração do agente incompleta: %s. Confira se AGENT_TOKEN tem valor neste terminal.", exc)
        return 2
    media = _start_media_server(settings, settings.storage_root, backend)
    backend.attach_storage(storage)
    stopping = False

    def stop(signum, _frame):
        nonlocal stopping
        stopping = True
        log.info("sinal recebido: terminando o job atual e saindo", extra={"signal": signum})

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)

    while True:  # espera o servidor ficar disponível (ordem de subida do compose / reinícios / rede)
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

    backend.publish_all()  # armazenamento local: a nuvem passa a ver as músicas que já estão neste computador
    stop_threads = threading.Event()
    # a busca no YouTube roda numa thread própria: não pode esperar atrás de um job longo (Demucs)
    threading.Thread(target=search_serve, args=(backend.clone(), settings.cookies, stop_threads), name="search", daemon=True).start()
    # as vozes de apoio levam minutos em CPU: thread própria, uma música de cada vez, sem segurar a próxima do karaokê
    threading.Thread(target=backing_serve, args=(backend.clone(), storage, stop_threads), name="backing", daemon=True).start()
    # a exportação em MP4 também tem thread própria: leva um minuto e não pode esperar atrás do Demucs
    threading.Thread(target=export_serve, args=(backend.clone(), storage, stop_threads), name="export", daemon=True).start()
    # músicas processadas antes do recurso de tom ganham o tom em segundo plano (uma vez cada)
    # (o título do vídeo vem primeiro: é instantâneo e as duas atualizações reescrevem o mesmo meta.json, então não rodam juntas)
    threading.Thread(target=lambda: (titles_backfill(storage), key_backfill(storage)), name="backfill", daemon=True).start()
    threading.Thread(target=_heartbeat, args=(settings.heartbeat_file, backend.clone(), stop_threads), name="heartbeat", daemon=True).start()

    log.info("worker consumindo", extra={"consumer": consumer, "transport": "http" if settings.agent_url else "redis",
                                         "device": settings.device or "auto", "max_duration_s": settings.limits.max_duration,
                                         "min_free_gb": settings.limits.min_free_gb})

    code = 0
    try:
        # 1) o que ficou pendente deste consumidor (reinício no meio de um job)
        for job in backend.pending():
            if not stopping:
                handle(backend, storage, settings, job)

        last_claim = 0.0
        while not stopping:
            try:
                # 2) jobs abandonados por outro worker que caiu (sem ack há muito tempo)
                if time.monotonic() - last_claim > 60:
                    last_claim = time.monotonic()
                    for job in backend.reclaim(settings.stale_seconds):
                        if not stopping:
                            handle(backend, storage, settings, job)
                # 3) novos jobs
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
            close()  # saída pedida pelo dono: encerra a sessão (os pedidos pendentes viram "o dono saiu")
    log.info("worker encerrado")
    return code
