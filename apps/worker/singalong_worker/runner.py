"""Handling ONE job: retries, clear error messages and protection against a job that keeps bringing the worker down.

It knows neither Redis nor HTTP: it talks to a `Backend` (backend.py), so it is testable without either.
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
    cookies: "CookiePolicy | Path | None"  # the YouTube cookie policy (cookies.py); a path counts as "always"
    device: str | None
    langs: list[str]
    stale_seconds: int
    heartbeat_file: Path
    max_attempts: int = 3  # automatic attempts for transient failures (network, YouTube's limit)
    retry_wait: float = 5.0  # the wait before the 2nd attempt; then 4× for each new attempt (5 s, 20 s...)
    max_starts: int = 3  # how many times the same job may (re)start before it counts as "bringing the worker down"
    limits: Limits = field(default_factory=Limits)
    # local agent: if `agent_url` is set, the worker talks HTTP to the server (/agent/v1) instead of reading Redis
    agent_url: str | None = None
    agent_token: str | None = None
    agent_name: str = "Meu computador"  # the session's nickname, what the guests see
    # the agent's local media server (the TV fetches the songs from here): AGENT_MEDIA_PORT=0 turns it off and the cloud uses its own storage
    media_port: int = 8765
    media_host: str = "127.0.0.1"  # where it listens; in Docker, 0.0.0.0 (and publish the port)
    media_public: str | None = None  # the address the BROWSER uses, if it differs from http://127.0.0.1:<port> (Docker)
    allowed_origins: tuple = ()  # origins (the cloud page's) that may read the media; the default is AGENT_URL's

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
    """Runs the pipeline; transient failures are repeated after a wait, the others go up already translated (JobError)."""
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
                    raise  # it already was a translated JobError
                raise err from exc
            wait = settings.retry_wait * 4 ** (attempt - 1)
            log.warning("falha transitória, tentando de novo", extra={"job": job.video_id, "code": err.code, "attempt": attempt, "wait_s": wait})
            backend.set_state(job, status="processing", stage="retrying", error=f"{err.message} (tentativa {attempt} de {settings.max_attempts})")
            sleep(wait)


def handle(backend, storage: LocalStorage, settings: Settings, job: Job, sleep: Callable[[float], None] = time.sleep) -> None:
    video_id, payload = job.video_id, job.payload
    started = time.monotonic()
    try:
        # Counts how many times THIS request started. A job that kills the worker (out of memory, for example) is delivered
        # again on every restart; without this limit it would bring the worker down forever. The counter resets when the API
        # queues the request again.
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
        backend.publish_song(video_id)  # local storage: the cloud sees the song before the job ends
        backend.set_state(job, status="ready", stage="", error="", error_code="", retry="")
        try:
            backend.request_backing(video_id)  # the backing vocals come later, in the background: the song is already ready
        except Exception:  # noqa: BLE001 - é um extra; na próxima subida do worker a música é encontrada de qualquer jeito
            log.warning("não consegui pedir as vozes de apoio", extra={"job": video_id})
        log.info("job pronto", extra={"job": video_id, "elapsed_s": round(time.monotonic() - started, 1)})
    except (NeedsLyrics, ValueError) as exc:
        # depends on a user's decision (choosing or fixing the lyrics' source), not a system failure
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
