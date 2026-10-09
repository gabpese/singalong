"""Tratamento de UM job: retentativas, mensagens de erro claras e proteção contra job que derruba o worker em loop.

Não depende do cliente Redis (recebe um objeto com hset/hincrby/expire/xack), então é testável sem Redis.
"""
import json
import logging
import os
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from .errors import AUTO, MANUAL, JobError, classify
from .pipeline import Limits, NeedsLyrics, process
from .storage import LocalStorage

STREAM = "jobs"
GROUP = "workers"
log = logging.getLogger("worker.job")

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
    max_attempts: int = 3  # tentativas automáticas para falhas transitórias (rede, limite do YouTube)
    retry_wait: float = 5.0  # espera antes da 2ª tentativa; depois 4× a cada nova tentativa (5 s, 20 s...)
    max_starts: int = 3  # quantas vezes um mesmo job pode (re)começar antes de ser dado como "derruba o worker"
    limits: Limits = field(default_factory=Limits)

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
            max_attempts=int(env.get("WORKER_MAX_ATTEMPTS", "3")),
            retry_wait=float(env.get("WORKER_RETRY_WAIT", "5")),
            max_starts=int(env.get("WORKER_MAX_STARTS", "3")),
            limits=Limits.from_env(),
        )


def set_job(r, video_id: str, **fields) -> None:
    """Atualiza o estado do job (hash job:<id>), que a API lê para mostrar o progresso."""
    key = f"job:{video_id}"
    r.hset(key, mapping={**{k: "" if v is None else str(v) for k, v in fields.items()}, "updated_at": int(time.time() * 1000)})
    status = fields.get("status")
    if status == "ready":
        r.expire(key, DONE_TTL)
    elif status in ("failed", "needs_lyrics"):
        r.expire(key, FAILED_TTL)


def _fail(r, video_id: str, err: JobError) -> None:
    set_job(r, video_id, status="failed", stage="", error=err.message, error_code=err.code, retry=err.retry)


def _run(r, storage: LocalStorage, settings: Settings, video_id: str, payload: dict, sleep: Callable[[float], None]) -> None:
    """Roda o pipeline; falhas transitórias são repetidas com espera, as demais sobem já traduzidas (JobError)."""
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
                on_stage=lambda stage: set_job(r, video_id, status="processing", stage=stage),
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
            log.warning("falha transitória, tentando de novo", extra={"job": video_id, "code": err.code, "attempt": attempt, "wait_s": wait})
            set_job(r, video_id, status="processing", stage="retrying", error=f"{err.message} (tentativa {attempt} de {settings.max_attempts})")
            sleep(wait)


def handle(r, storage: LocalStorage, settings: Settings, msg_id: str, fields: dict, sleep: Callable[[float], None] = time.sleep) -> None:
    video_id = fields["video_id"]
    payload = json.loads(fields["payload"])
    started = time.monotonic()
    try:
        # Conta quantas vezes ESTE pedido começou. Um job que mata o worker (falta de memória, por exemplo) é entregue de
        # novo a cada reinício; sem esse limite ele derrubaria o worker para sempre. O contador zera quando a API
        # enfileira o pedido de novo (o script Lua recria o hash).
        starts = int(r.hincrby(f"job:{video_id}", "starts", 1))
        if starts > settings.max_starts:
            log.error("job derrubou o worker várias vezes, desistindo", extra={"job": video_id, "starts": starts})
            _fail(r, video_id, JobError(
                "worker_crash",
                "O processamento desta música travou o worker mais de uma vez (talvez falta de memória). "
                "Tente outra versão do vídeo ou tente de novo mais tarde.",
                MANUAL,
            ))
            return

        log.info("job começou", extra={"job": video_id, "url": payload.get("url"), "lyrics": payload.get("lyrics_source"), "start": starts})
        set_job(r, video_id, status="processing", stage="", error="", error_code="", retry="")
        _run(r, storage, settings, video_id, payload, sleep)
        set_job(r, video_id, status="ready", stage="", error="", error_code="", retry="")
        log.info("job pronto", extra={"job": video_id, "elapsed_s": round(time.monotonic() - started, 1)})
    except (NeedsLyrics, ValueError) as exc:
        # depende de uma decisão do usuário (escolher/corrigir a fonte da letra), não é falha do sistema
        set_job(r, video_id, status="needs_lyrics", stage="", error=str(exc), error_code="", retry="")
        log.info("job precisa de letra", extra={"job": video_id, "reason": str(exc)})
    except JobError as err:
        log.error("job falhou", extra={"job": video_id, "code": err.code, "retry": err.retry, "reason": err.message},
                  exc_info=err.__cause__ is not None)
        _fail(r, video_id, err)
    except Exception as exc:  # noqa: BLE001 - nada escapa: o job termina com uma mensagem, nunca fica "processando" para sempre
        err = classify(exc)
        log.exception("job falhou com erro inesperado", extra={"job": video_id, "code": err.code})
        _fail(r, video_id, err)
    finally:
        r.xack(STREAM, GROUP, msg_id)
