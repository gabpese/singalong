"""Transporte do worker: de onde vêm os jobs e para onde vão o estado e as respostas.

O pipeline (runner.py, pipeline.py...) não sabe de Redis nem de HTTP; fala com um `Backend`:

  RedisBackend  o worker clássico (Docker, o PC do dono lendo o Redis direto). Contrato em apps/api/src/jobs.js, jeito (1).
  HttpBackend   o agente local: só HTTP de SAÍDA para /agent/v1 do servidor, sem acesso ao Redis. Jeito (2) do mesmo contrato.

Os dois têm os mesmos métodos, então o runner e as threads (busca, exportação, vozes de apoio) rodam iguais nos dois.
Cada thread usa a sua própria cópia (`clone()`): conexões e o bloqueio de uma não podem atrapalhar as outras.
"""
import json
import logging
import os
import queue
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any

from . import catalog, hardware
from .version import current_version

log = logging.getLogger("worker.backend")

STREAM = "jobs"
GROUP = "workers"
SEARCH_KEY = "search:req"
SEARCH_RESULT_TTL = 60
EXPORT_KEY = "export:req"
EXPORT_STATE_TTL = 3600
BACKING_KEY = "backing:req"
DONE_TTL = 3600  # status "ready" some do Redis depois de 1 h (a verdade passa a ser o storage)
FAILED_TTL = 86400

TERMINAL = ("ready", "needs_lyrics", "failed")
JOB_FIELDS = ("stage", "error", "error_code", "retry")
CATALOG_BATCH = 50  # músicas por pedido de catálogo (o servidor aceita até 100)
MAX_FIELD = 500  # o servidor recusa textos maiores que isso
AGENT_VERSION = current_version()


class BackendUnavailable(Exception):
    """Falha passageira de conexão (rede, servidor reiniciando): tentar de novo daqui a pouco."""


class AuthError(Exception):
    """O servidor não reconhece mais o token do agente (revogado): não adianta insistir."""


class UpdateRequired(BackendUnavailable):
    """O servidor exige uma versão mais nova do app. Parece uma falha passageira: o agente espera e tenta de novo, e volta a
    trabalhar sozinho assim que o app for atualizado."""


class Rejected(Exception):
    """O servidor recusou o pedido (4xx, exceto 401). `code` é o código estável do erro."""

    def __init__(self, status: int, code: str, message: str = ""):
        super().__init__(f"{status} {code}: {message}")
        self.status, self.code, self.message = status, code, message


@dataclass
class Job:
    video_id: str
    payload: dict
    ref: Any = None  # identificação interna do backend (o id da mensagem no Redis, para o ack)
    attempt: int | None = None  # quantas vezes este pedido foi entregue (o servidor conta no jeito HTTP)


def _error_detail(exc: urllib.error.HTTPError) -> dict:
    """O corpo JSON de uma resposta de erro ({ error, message }); fecha a resposta."""
    try:
        detail = json.loads(exc.read() or b"{}")
        return detail if isinstance(detail, dict) else {}
    except ValueError:
        return {}
    finally:
        exc.close()


def _text(value: Any) -> str:
    return "" if value is None else str(value)[:MAX_FIELD]


# ---------------------------------------------------------------------------------------------------------------------
# Redis (worker clássico)
# ---------------------------------------------------------------------------------------------------------------------
def _entries(response) -> list[tuple[str, dict]]:
    return [entry for _stream, entries in (response or []) for entry in entries]


class RedisBackend:
    def __init__(self, url: str, consumer: str, client=None):
        self.url, self.consumer = url, consumer
        self._client = client

    @property
    def r(self):
        if self._client is None:
            import redis  # import tardio: o resto do worker (e os testes) não precisa do cliente Redis

            # socket_timeout MAIOR que o block do XREADGROUP (5 s), senão a leitura ociosa estoura o timeout
            self._client = redis.Redis.from_url(self.url, decode_responses=True, socket_timeout=30, socket_connect_timeout=5)
        return self._client

    @staticmethod
    def _transient() -> tuple:
        base = (ConnectionError, TimeoutError)
        try:
            import redis
        except ImportError:  # os testes e o modo CLI não precisam do cliente Redis
            return base
        return base + (redis.ConnectionError, redis.TimeoutError)

    def _guard(self, fn):
        try:
            return fn()
        except self._transient() as exc:
            raise BackendUnavailable(str(exc)) from exc

    def clone(self) -> "RedisBackend":
        return RedisBackend(self.url, self.consumer)

    def connect(self) -> None:
        def go():
            self.r.ping()
            try:
                # id "0": jobs enfileirados antes de o grupo existir não se perdem
                self.r.xgroup_create(STREAM, GROUP, id="0", mkstream=True)
            except Exception as exc:  # noqa: BLE001 - BUSYGROUP (o grupo já existe) é o caso normal
                if "BUSYGROUP" not in str(exc):
                    raise

        self._guard(go)

    def heartbeat(self) -> None:  # o worker clássico só toca o arquivo de saúde (consumer.py)
        return None

    # armazenamento local só existe no agente: no worker clássico a música já está na pasta que a API lê
    def attach_storage(self, storage) -> None:
        return None

    def publish_song(self, video_id: str, force: bool = False) -> None:
        return None

    def publish_all(self) -> int:
        return 0

    @staticmethod
    def _job(msg_id: str, fields: dict) -> Job:
        return Job(video_id=fields["video_id"], payload=json.loads(fields["payload"]), ref=msg_id)

    def pending(self) -> list[Job]:
        """O que ficou pendente com este consumidor (o worker reiniciou no meio de um job)."""
        response = self._guard(lambda: self.r.xreadgroup(GROUP, self.consumer, {STREAM: "0"}, count=50))
        return [self._job(m, f) for m, f in _entries(response) if f]

    def reclaim(self, min_idle_seconds: float) -> list[Job]:
        """Jobs abandonados por outro worker que caiu (sem ack há muito tempo)."""
        claimed = self._guard(lambda: self.r.xautoclaim(
            STREAM, GROUP, self.consumer, min_idle_time=int(min_idle_seconds * 1000), start_id="0-0", count=10))
        return [self._job(m, f) for m, f in claimed[1] if f]

    def next_job(self, block_seconds: float) -> Job | None:
        response = self._guard(lambda: self.r.xreadgroup(GROUP, self.consumer, {STREAM: ">"}, count=1, block=int(block_seconds * 1000)))
        entries = _entries(response)
        return self._job(*entries[0]) if entries else None

    def begin(self, job: Job) -> int:
        """Conta quantas vezes ESTE pedido começou. Um job que mata o worker é entregue de novo a cada reinício; o runner
        usa o contador para desistir. Zera quando a API enfileira o pedido de novo (o script Lua recria o hash)."""
        return int(self._guard(lambda: self.r.hincrby(f"job:{job.video_id}", "starts", 1)))

    def set_state(self, job: Job, **fields) -> None:
        """Atualiza o estado do job (hash job:<id>), que a API lê para mostrar o progresso."""
        key = f"job:{job.video_id}"
        status = fields.get("status")

        def go():
            self.r.hset(key, mapping={**{k: "" if v is None else str(v) for k, v in fields.items()}, "updated_at": int(time.time() * 1000)})
            if status == "ready":
                self.r.expire(key, DONE_TTL)
            elif status in ("failed", "needs_lyrics"):
                self.r.expire(key, FAILED_TTL)

        self._guard(go)

    def finish(self, job: Job) -> None:
        self._guard(lambda: self.r.xack(STREAM, GROUP, job.ref))

    def request_backing(self, video_id: str) -> None:
        self._guard(lambda: self.r.lpush(BACKING_KEY, video_id))

    def next_backing(self, block_seconds: float) -> str | None:
        item = self._guard(lambda: self.r.brpop(BACKING_KEY, timeout=max(1, int(block_seconds))))
        return item[1] if item else None

    def next_search(self, block_seconds: float) -> dict | None:
        item = self._guard(lambda: self.r.brpop(SEARCH_KEY, timeout=max(1, int(block_seconds))))
        return json.loads(item[1]) if item else None

    def reply_search(self, request_id: str, reply: dict) -> None:
        def go():
            key = f"search:res:{request_id}"
            self.r.lpush(key, json.dumps(reply, ensure_ascii=False))
            self.r.expire(key, SEARCH_RESULT_TTL)

        self._guard(go)

    def next_export(self, block_seconds: float) -> dict | None:
        item = self._guard(lambda: self.r.brpop(EXPORT_KEY, timeout=max(1, int(block_seconds))))
        return json.loads(item[1]) if item else None

    def set_export_state(self, video_id: str, pitch: int, status: str, error: str = "") -> None:
        def go():
            key = f"export:{video_id}:{pitch}"
            self.r.hset(key, mapping={"status": status, "error": error, "updated_at": int(time.time() * 1000)})
            self.r.expire(key, EXPORT_STATE_TTL)

        self._guard(go)


# ---------------------------------------------------------------------------------------------------------------------
# HTTP (agente local)
# ---------------------------------------------------------------------------------------------------------------------
@dataclass
class _Shared:
    """O que as cópias (threads) do mesmo agente compartilham: a sessão e a fila interna das vozes de apoio."""

    session_id: str | None = None
    media_base: str | None = None  # o endereço do servidor local de mídia (o que o navegador usa)
    storage: Any = None  # o armazenamento local, para publicar o catálogo
    unpublished: set = field(default_factory=set)  # músicas que não deu para publicar (rede): tenta de novo na batida de coração
    backing: "queue.Queue[str]" = field(default_factory=queue.Queue)
    lock: threading.Lock = field(default_factory=threading.Lock)
    update: dict = field(default_factory=dict)  # o último aviso de versão do servidor (para a interface mostrar)


class HttpBackend:
    def __init__(self, base_url: str, token: str, session_name: str = "Meu computador", shared: _Shared | None = None,
                 opener=None, retry_wait: float = 2.0):
        self.base = base_url.rstrip("/") + "/agent/v1"
        self.token, self.session_name = token, session_name
        self._shared = shared or _Shared()
        self._open = opener or urllib.request.urlopen
        self.retry_wait = retry_wait

    @property
    def update(self) -> dict:
        """O aviso de versão do servidor: { status: ok|update_available|update_required|unknown, latest, minimum, notes, url }."""
        return self._shared.update

    def clone(self) -> "HttpBackend":
        return HttpBackend(self.base[: -len("/agent/v1")], self.token, self.session_name, self._shared, self._open, self.retry_wait)

    @property
    def session_id(self) -> str | None:
        return self._shared.session_id

    @property
    def media_base(self) -> str | None:
        return self._shared.media_base

    @media_base.setter
    def media_base(self, value: str | None) -> None:
        self._shared.media_base = value

    def attach_storage(self, storage) -> None:
        self._shared.storage = storage

    # --- HTTP ---
    def _call(self, method: str, path: str, body: dict | None = None, timeout: float = 30) -> dict | None:
        data = json.dumps(body if body is not None else {}).encode() if method != "GET" else None
        request = urllib.request.Request(self.base + path, data=data, method=method, headers={
            "Authorization": f"Bearer {self.token}", "Content-Type": "application/json", "Accept": "application/json",
            "User-Agent": f"singalong-agent/{AGENT_VERSION}",
        })
        try:
            with self._open(request, timeout=timeout) as response:
                raw = response.read()
                return json.loads(raw) if raw else None
        except urllib.error.HTTPError as exc:
            detail = _error_detail(exc)
            if exc.code == 401:
                raise AuthError(detail.get("message") or "token do agente recusado") from exc
            if exc.code == 426:
                raise UpdateRequired(str(detail.get("message") or "atualize o aplicativo")) from exc
            if exc.code >= 500 or exc.code == 429:
                raise BackendUnavailable(f"servidor respondeu {exc.code}") from exc
            raise Rejected(exc.code, str(detail.get("error", "")), str(detail.get("message", ""))) from exc
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as exc:
            raise BackendUnavailable(str(getattr(exc, "reason", exc))) from exc

    def _retry(self, fn, tries: int = 5):
        """Para o que não pode se perder (terminar um job): repete com espera crescente em falhas de conexão."""
        for attempt in range(1, tries + 1):
            try:
                return fn()
            except BackendUnavailable:
                if attempt == tries:
                    raise
                time.sleep(self.retry_wait * attempt)

    # --- sessão ---
    def connect(self, keep_name: bool = False) -> None:
        """Entra no servidor: valida o token e inicia a sessão (ou retoma a que já estava ativa, se o agente reiniciou).
        `keep_name`: ao retomar, mantém o apelido que a sessão já tem (outro comando, como --create-room, não deve renomeá-la)."""
        me = self._call("GET", "/me") or {}
        current = me.get("session") or {}
        resume = current.get("id")
        name = current.get("display_name") if keep_name and resume else self.session_name
        body = {"display_name": name or self.session_name, **({"resume_id": resume} if resume else {}),
                **({"media_base": self.media_base} if self.media_base else {})}
        session = self._call("POST", "/sessions", body) or {}
        self._shared.session_id = session.get("id")
        log.info("sessão do agente ativa", extra={"session": self._shared.session_id, "resumed": bool(resume)})

    def create_room(self) -> dict:
        """Cria uma sala da sessão: { code, host_token, session_id }."""
        return self._call("POST", f"/sessions/{self._shared.session_id}/rooms") or {}

    def end_session(self) -> None:
        if self._shared.session_id:
            try:
                self._call("DELETE", f"/sessions/{self._shared.session_id}", timeout=10)
            except (BackendUnavailable, Rejected):
                pass
            self._shared.session_id = None

    def heartbeat(self) -> None:
        reply = self._call("POST", "/heartbeat", {"version": AGENT_VERSION, "hardware": hardware.summary(), **({"media_base": self.media_base} if self.media_base else {})}, timeout=15) or {}
        self._note_update(reply.get("update") or {})
        if not reply.get("session_id"):  # o servidor encerrou a sessão (varredura): inicia outra
            self.connect()
            self.publish_all()  # a sessão nova começa sem saber das músicas: o catálogo é do dispositivo, mas confere
        for video_id in list(self._shared.unpublished):  # o que não deu para publicar antes (rede caiu)
            self.publish_song(video_id)

    def _note_update(self, info: dict) -> None:
        """Guarda o aviso de versão do servidor (para a interface) e registra no log só quando ele muda."""
        status = info.get("status")
        if status != self._shared.update.get("status"):
            if status == "update_required":
                log.error("esta versão do app é antiga demais: atualize para continuar", extra={"current": AGENT_VERSION, "minimum": info.get("minimum"), "notes": info.get("notes")})
            elif status == "update_available":
                log.warning("há uma versão nova do app", extra={"current": AGENT_VERSION, "latest": info.get("latest"), "notes": info.get("notes")})
        self._shared.update = info

    def _reconnect_if_no_session(self, exc: Rejected) -> bool:
        if exc.code == "no_active_session":
            self.connect()
            return True
        return False

    def _claim(self, path: str, block_seconds: float) -> dict | None:
        wait_ms = max(0, min(int(block_seconds * 1000), 25_000))
        try:
            return self._call("POST", path, {"wait_ms": wait_ms}, timeout=wait_ms / 1000 + 15)
        except Rejected as exc:
            if self._reconnect_if_no_session(exc):
                return None
            raise

    # --- catálogo local ---
    def publish_song(self, video_id: str, force: bool = False) -> None:
        """Publica (ou atualiza) uma música no catálogo da nuvem. Uma falha de rede não derruba o job: fica para a próxima batida.
        `force`: publica mesmo sem servidor local de mídia neste processo (o comando de importar roda fora do agente)."""
        storage = self._shared.storage
        if storage is None or (not force and not self._shared.media_base):
            return  # sem servidor local de mídia, a nuvem usa o armazenamento dela
        entry = catalog.entry_for(storage, video_id)
        if entry is None:
            return
        try:
            self._retry(lambda: self._call("PUT", "/library", {"songs": [entry]}), tries=3)
            self._shared.unpublished.discard(video_id)
        except (BackendUnavailable, Rejected, AuthError) as exc:
            self._shared.unpublished.add(video_id)
            log.warning("não consegui publicar a música no catálogo", extra={"job": video_id, "reason": str(exc)})

    def publish_all(self) -> int:
        """Publica o catálogo inteiro (ao iniciar a sessão): em lotes, para caber no limite de cada pedido."""
        storage = self._shared.storage
        if storage is None or not self._shared.media_base:
            return 0
        entries = catalog.scan(storage)
        sent = 0
        for start in range(0, len(entries), CATALOG_BATCH):
            batch = entries[start:start + CATALOG_BATCH]
            try:
                self._retry(lambda: self._call("PUT", "/library", {"songs": batch}), tries=3)
                sent += len(batch)
            except (BackendUnavailable, Rejected, AuthError) as exc:
                self._shared.unpublished.update(entry["id"] for entry in batch)
                log.warning("não consegui publicar parte do catálogo", extra={"reason": str(exc), "songs": len(batch)})
        log.info("catálogo local publicado", extra={"songs": sent, "total": len(entries)})
        return sent

    # --- jobs ---
    def pending(self) -> list[Job]:
        return []  # o servidor entrega primeiro o que ficou com este dispositivo (em next_job)

    def reclaim(self, min_idle_seconds: float) -> list[Job]:
        return []  # idem: o prazo "sem sinal" é do servidor

    def next_job(self, block_seconds: float) -> Job | None:
        data = self._claim("/jobs/claim", block_seconds)
        job = (data or {}).get("job")
        return Job(video_id=job["id"], payload=job["payload"], attempt=job.get("attempt")) if job else None

    def begin(self, job: Job) -> int:
        return int(job.attempt or 1)  # o servidor conta cada entrega

    def set_state(self, job: Job, **fields) -> None:
        status = fields.pop("status", None)
        body = {name: _text(fields[name]) for name in JOB_FIELDS if name in fields}
        try:
            if status in TERMINAL:
                self._retry(lambda: self._call("POST", f"/jobs/{job.video_id}/complete", {"status": status, **body}))
            else:
                self._call("POST", f"/jobs/{job.video_id}/progress", body)
        except BackendUnavailable as exc:
            # perder um aviso de progresso não importa; perder o final importa (por isso o retry acima), mas não derruba o job
            log.warning("não consegui avisar o servidor", extra={"job": job.video_id, "status": status, "reason": str(exc)})
        except Rejected as exc:
            log.warning("o servidor recusou o estado do job", extra={"job": job.video_id, "status": status, "code": exc.code})

    def finish(self, job: Job) -> None:
        return None  # o "complete" já confirmou o job no servidor

    # --- vozes de apoio: fila interna (não passa pelo servidor) ---
    def request_backing(self, video_id: str) -> None:
        self._shared.backing.put(video_id)

    def next_backing(self, block_seconds: float) -> str | None:
        try:
            return self._shared.backing.get(timeout=max(0.1, block_seconds))
        except queue.Empty:
            return None

    # --- busca ---
    def next_search(self, block_seconds: float) -> dict | None:
        return (self._claim("/search/claim", block_seconds) or {}).get("request")

    def reply_search(self, request_id: str, reply: dict) -> None:
        body = {"error": _text(reply["error"])} if reply.get("error") else {"results": reply.get("results", [])}
        try:
            self._retry(lambda: self._call("POST", f"/search/{request_id}/result", body))
        except (BackendUnavailable, Rejected) as exc:
            log.warning("não consegui devolver a busca", extra={"search": request_id, "reason": str(exc)})

    # --- exportação ---
    def next_export(self, block_seconds: float) -> dict | None:
        return (self._claim("/exports/claim", block_seconds) or {}).get("request")

    def set_export_state(self, video_id: str, pitch: int, status: str, error: str = "") -> None:
        try:
            self._retry(lambda: self._call("POST", f"/exports/{video_id}/{pitch}/state", {"status": status, **({"error": _text(error)} if error else {})}))
        except (BackendUnavailable, Rejected) as exc:
            log.warning("não consegui informar a exportação", extra={"job": video_id, "reason": str(exc)})


def pair(base_url: str, code: str, name: str = "Meu computador", opener=None, timeout: float = 20) -> dict:
    """Troca o código de pareamento por um token de dispositivo: { device_id, token }. Sem autenticação (o código é o segredo)."""
    request = urllib.request.Request(
        base_url.rstrip("/") + "/agent/v1/pair/complete", method="POST",
        data=json.dumps({"code": code, "name": name}).encode(),
        headers={"Content-Type": "application/json", "Accept": "application/json", "User-Agent": f"singalong-agent/{AGENT_VERSION}"},
    )
    try:
        with (opener or urllib.request.urlopen)(request, timeout=timeout) as response:
            return json.loads(response.read())
    except urllib.error.HTTPError as exc:
        detail = _error_detail(exc)
        raise Rejected(exc.code, str(detail.get("error", "")), str(detail.get("message", ""))) from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise BackendUnavailable(str(getattr(exc, "reason", exc))) from exc


def make_backend(redis_url: str, consumer: str, agent_url: str | None, agent_token: str | None, session_name: str):
    """O agente local (HTTP) se `AGENT_URL` está definida; senão o worker clássico (Redis)."""
    if agent_url:
        if not agent_token:
            raise ValueError("AGENT_URL exige AGENT_TOKEN (o token de dispositivo gerado no pareamento)")
        return HttpBackend(agent_url, agent_token, session_name)
    return RedisBackend(redis_url, consumer)
