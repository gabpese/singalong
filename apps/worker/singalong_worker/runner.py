"""Tratamento de UM job: retentativas, mensagens de erro claras e proteção contra job que derruba o worker em loop.

Não conhece Redis nem HTTP: fala com um `Backend` (backend.py), então é testável sem nenhum dos dois.
"""
import logging
import os
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from .backend import Job
from .cookies import CookiePolicy, load_policy
from .devices import engine_device
from .errors import AUTO, MANUAL, JobError, classify
from .pipeline import Limits, NeedsLyrics, process
from .storage import LocalStorage

log = logging.getLogger("worker.job")


@dataclass
class Settings:
    redis_url: str
    storage_root: str
    cookies: "CookiePolicy | Path | None"  # a política de cookies do YouTube (cookies.py); um caminho vale como "sempre"
    device: str | None
    langs: list[str]
    stale_seconds: int
    heartbeat_file: Path
    max_attempts: int = 3  # tentativas automáticas para falhas transitórias (rede, limite do YouTube)
    retry_wait: float = 5.0  # espera antes da 2ª tentativa; depois 4× a cada nova tentativa (5 s, 20 s...)
    max_starts: int = 3  # quantas vezes um mesmo job pode (re)começar antes de ser dado como "derruba o worker"
    limits: Limits = field(default_factory=Limits)
    # agente local: se `agent_url` está definida, o worker fala HTTP com o servidor (/agent/v1) em vez de ler o Redis
    agent_url: str | None = None
    agent_token: str | None = None
    agent_name: str = "Meu computador"  # o apelido da sessão, o que os convidados veem
    # servidor local de mídia do agente (a TV busca as músicas daqui): AGENT_MEDIA_PORT=0 desliga e a nuvem usa o armazenamento dela
    media_port: int = 8765
    media_host: str = "127.0.0.1"  # onde escuta; em Docker, 0.0.0.0 (e publique a porta)
    media_public: str | None = None  # o endereço que o NAVEGADOR usa, se for diferente de http://127.0.0.1:<porta> (Docker)
    allowed_origins: tuple = ()  # origens (a da página da nuvem) que podem ler a mídia; o padrão é a de AGENT_URL

    @classmethod
    def from_env(cls) -> "Settings":
        env = os.environ
        return cls(
            redis_url=env.get("REDIS_URL", "redis://localhost:6379/0"),
            storage_root=env.get("STORAGE_ROOT", "./storage"),
            cookies=load_policy(env),
            device=env.get("DEMUCS_DEVICE") or engine_device(env),
            langs=env.get("LANGS", "pt,en").split(","),
            stale_seconds=int(env.get("WORKER_STALE_SECONDS", "1800")),
            heartbeat_file=Path(env.get("WORKER_HEARTBEAT_FILE", "/tmp/worker-heartbeat")),
            max_attempts=int(env.get("WORKER_MAX_ATTEMPTS", "3")),
            retry_wait=float(env.get("WORKER_RETRY_WAIT", "5")),
            max_starts=int(env.get("WORKER_MAX_STARTS", "3")),
            limits=Limits.from_env(),
            agent_url=env.get("AGENT_URL") or None,
            agent_token=env.get("AGENT_TOKEN") or None,
            agent_name=env.get("AGENT_SESSION_NAME") or "Meu computador",
            media_port=int(env.get("AGENT_MEDIA_PORT", "8765")),
            media_host=env.get("AGENT_MEDIA_HOST") or "127.0.0.1",
            media_public=(env.get("AGENT_MEDIA_PUBLIC") or "").rstrip("/") or None,
            allowed_origins=tuple(o.strip() for o in (env.get("AGENT_ALLOWED_ORIGINS") or "").split(",") if o.strip()),
        )


def _fail(backend, job: Job, err: JobError) -> None:
    backend.set_state(job, status="failed", stage="", error=err.message, error_code=err.code, retry=err.retry)


def _run(backend, storage: LocalStorage, settings: Settings, job: Job, sleep: Callable[[float], None]) -> None:
    """Roda o pipeline; falhas transitórias são repetidas com espera, as demais sobem já traduzidas (JobError)."""
    payload = job.payload
    for attempt in range(1, settings.max_attempts + 1):
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
                on_stage=lambda stage: backend.set_state(job, status="processing", stage=stage),
                lyrics_loose=bool(payload.get("lyrics_loose")),
                limits=settings.limits,
            )
            return
        except (NeedsLyrics, ValueError):
            raise
        except Exception as exc:  # noqa: BLE001 - tudo é traduzido por classify
            err = classify(exc)
            if err.retry != AUTO or attempt >= settings.max_attempts:
                if err is exc:
                    raise  # já era um JobError traduzido
                raise err from exc
            wait = settings.retry_wait * 4 ** (attempt - 1)
            log.warning("falha transitória, tentando de novo", extra={"job": job.video_id, "code": err.code, "attempt": attempt, "wait_s": wait})
            backend.set_state(job, status="processing", stage="retrying", error=f"{err.message} (tentativa {attempt} de {settings.max_attempts})")
            sleep(wait)


def handle(backend, storage: LocalStorage, settings: Settings, job: Job, sleep: Callable[[float], None] = time.sleep) -> None:
    video_id, payload = job.video_id, job.payload
    started = time.monotonic()
    try:
        # Conta quantas vezes ESTE pedido começou. Um job que mata o worker (falta de memória, por exemplo) é entregue de
        # novo a cada reinício; sem esse limite ele derrubaria o worker para sempre. O contador zera quando a API
        # enfileira o pedido de novo.
        starts = backend.begin(job)
        if starts > settings.max_starts:
            log.error("job derrubou o worker várias vezes, desistindo", extra={"job": video_id, "starts": starts})
            _fail(backend, job, JobError(
                "worker_crash",
                "O processamento desta música travou o worker mais de uma vez (talvez falta de memória). "
                "Tente outra versão do vídeo ou tente de novo mais tarde.",
                MANUAL,
            ))
            return

        log.info("job começou", extra={"job": video_id, "url": payload.get("url"), "lyrics": payload.get("lyrics_source"), "start": starts})
        backend.set_state(job, status="processing", stage="", error="", error_code="", retry="")
        _run(backend, storage, settings, job, sleep)
        backend.publish_song(video_id)  # armazenamento local: a nuvem passa a ver a música antes de o job terminar
        backend.set_state(job, status="ready", stage="", error="", error_code="", retry="")
        try:
            backend.request_backing(video_id)  # as vozes de apoio saem depois, em segundo plano: a música já está pronta
        except Exception:  # noqa: BLE001 - é um extra; na próxima subida do worker a música é encontrada de qualquer jeito
            log.warning("não consegui pedir as vozes de apoio", extra={"job": video_id})
        log.info("job pronto", extra={"job": video_id, "elapsed_s": round(time.monotonic() - started, 1)})
    except (NeedsLyrics, ValueError) as exc:
        # depende de uma decisão do usuário (escolher/corrigir a fonte da letra), não é falha do sistema
        backend.set_state(job, status="needs_lyrics", stage="", error=str(exc), error_code="", retry="")
        log.info("job precisa de letra", extra={"job": video_id, "reason": str(exc)})
    except JobError as err:
        log.error("job falhou", extra={"job": video_id, "code": err.code, "retry": err.retry, "reason": err.message},
                  exc_info=err.__cause__ is not None)
        _fail(backend, job, err)
    except Exception as exc:  # noqa: BLE001 - nada escapa: o job termina com uma mensagem, nunca fica "processando" para sempre
        err = classify(exc)
        log.exception("job falhou com erro inesperado", extra={"job": video_id, "code": err.code})
        _fail(backend, job, err)
    finally:
        backend.finish(job)
