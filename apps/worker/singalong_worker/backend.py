"""The worker's transport: where the jobs come from and where the state and the answers go.

The pipeline (runner.py, pipeline.py...) knows nothing about Redis or HTTP; it talks to a `Backend`:

  RedisBackend  the classic worker (Docker, the owner's PC reading Redis directly). Contract in apps/api/src/jobs.ts, way 1).
  HttpBackend   the local agent: only OUTGOING HTTP to the server's /agent/v1, no access to Redis. Way 2) of the same contract.

Both have the same methods, so the runner and the threads (search, export, backing vocals) run the same on both.
Each thread uses its own copy (`clone()`): one thread's connections and blocking must not get in the others' way.
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
DONE_TTL = 3600  # the "ready" status leaves Redis after 1 h (storage becomes the truth)
FAILED_TTL = 86400

TERMINAL = ("ready", "needs_lyrics", "failed")
JOB_FIELDS = ("stage", "error", "error_code", "retry")
CATALOG_BATCH = 50  # songs per catalog request (the server accepts up to 100)
MAX_FIELD = 500  # the server refuses texts longer than this
AGENT_VERSION = current_version()


class BackendUnavailable(Exception):
    """A passing connection failure (network, server restarting): try again shortly."""


class AuthError(Exception):
    """The server no longer recognizes the agent's token (revoked): insisting is useless."""


class UpdateRequired(BackendUnavailable):
    """The server requires a newer app version. It looks like a passing failure: the agent waits and tries again, and gets back
    to work by itself as soon as the app is updated."""


class Rejected(Exception):
    """The server refused the request (4xx, except 401). `code` is the error's stable code."""

    def __init__(self, status: int, code: str, message: str = ""):
        super().__init__(f"{status} {code}: {message}")
        self.status, self.code, self.message = status, code, message


@dataclass
class Job:
    video_id: str
    payload: dict
    ref: Any = None  # the backend's internal id (the message id in Redis, for the ack)
    attempt: int | None = None  # how many times this request was delivered (the server counts in the HTTP way)


def _error_detail(exc: urllib.error.HTTPError) -> dict:
    """The JSON body of an error answer ({ error, message }); closes the answer."""
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
# Redis (classic worker)
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
            import redis  # a late import: the rest of the worker (and the tests) does not need the Redis client

            # socket_timeout LONGER than XREADGROUP's block (5 s), or the idle read hits the timeout
            self._client = redis.Redis.from_url(self.url, decode_responses=True, socket_timeout=30, socket_connect_timeout=5)
        return self._client

    @staticmethod
    def _transient() -> tuple:
        base = (ConnectionError, TimeoutError)
        try:
            import redis
        except ImportError:  # the tests and the CLI mode do not need the Redis client
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
                # id "0": jobs queued before the group existed are not lost
                self.r.xgroup_create(STREAM, GROUP, id="0", mkstream=True)
            except Exception as exc:  # noqa: BLE001 - BUSYGROUP (o grupo já existe) é o caso normal
                if "BUSYGROUP" not in str(exc):
                    raise

        self._guard(go)

    def heartbeat(self) -> None:  # the classic worker only touches the health file (consumer.py)
        return None

    # local storage only exists in the agent: in the classic worker the song is already in the folder the API reads
    def attach_storage(self, storage) -> None:
        return None

    def publish_song(self, video_id: str, force: bool = False) -> None:
        return None

    def publish_all(self) -> int:
        return 0

    # the cloud only exists for the agent (the classic worker already writes to the folder the API reads)
    cloud_enabled = False

    def cloud_sync(self, video_id: str) -> bool:
        return False

    def cloud_backfill(self) -> int:
        return 0

    def cloud_next(self, block_seconds: float) -> str | None:
        time.sleep(min(block_seconds, 1.0))
        return None

    @staticmethod
    def _job(msg_id: str, fields: dict) -> Job:
        return Job(video_id=fields["video_id"], payload=json.loads(fields["payload"]), ref=msg_id)

    def pending(self) -> list[Job]:
        """What was left pending with this consumer (the worker restarted in the middle of a job)."""
        response = self._guard(lambda: self.r.xreadgroup(GROUP, self.consumer, {STREAM: "0"}, count=50))
        return [self._job(m, f) for m, f in _entries(response) if f]

    def reclaim(self, min_idle_seconds: float) -> list[Job]:
        """Jobs abandoned by another worker that went down (no ack for a long time)."""
        claimed = self._guard(lambda: self.r.xautoclaim(
            STREAM, GROUP, self.consumer, min_idle_time=int(min_idle_seconds * 1000), start_id="0-0", count=10))
        return [self._job(m, f) for m, f in claimed[1] if f]

    def next_job(self, block_seconds: float) -> Job | None:
        response = self._guard(lambda: self.r.xreadgroup(GROUP, self.consumer, {STREAM: ">"}, count=1, block=int(block_seconds * 1000)))
        entries = _entries(response)
        return self._job(*entries[0]) if entries else None

    def begin(self, job: Job) -> int:
        """Counts how many times THIS request started. A job that kills the worker is delivered again on every restart; the runner
        uses the counter to give up. It resets when the API queues the request again (the Lua script recreates the hash)."""
        return int(self._guard(lambda: self.r.hincrby(f"job:{job.video_id}", "starts", 1)))

    def set_state(self, job: Job, **fields) -> None:
        """Updates the job's state (the job:<id> hash), which the API reads to show the progress."""
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
# HTTP (local agent)
# ---------------------------------------------------------------------------------------------------------------------
@dataclass
class _Shared:
    """What the copies (threads) of the same agent share: the session and the backing vocals' internal queue."""

    session_id: str | None = None
    media_base: str | None = None  # the local media server's address (what the browser uses)
    storage: Any = None  # the local storage, to publish the catalog
    unpublished: set = field(default_factory=set)  # songs that could not be published (network): tries again on the heartbeat
    cloud: bool = False  # the server allowed this computer to send the songs to the cloud (ENABLED_TO_SEND_TO_CLOUD)
    cloud_queue: Any = field(default_factory=queue.Queue)  # ids of the songs waiting to go up
    cloud_sent: dict = field(default_factory=dict)  # id → the signature of the files already sent (nothing unchanged is sent again)
    backing: "queue.Queue[str]" = field(default_factory=queue.Queue)
    lock: threading.Lock = field(default_factory=threading.Lock)
    update: dict = field(default_factory=dict)  # the server's last version notice (for the interface to show)


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
        """The server's version notice: { status: ok|update_available|update_required|unknown, latest, minimum, notes, url }."""
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
        """For what must not be lost (finishing a job): repeats with a growing wait on connection failures."""
        for attempt in range(1, tries + 1):
            try:
                return fn()
            except BackendUnavailable:
                if attempt == tries:
                    raise
                time.sleep(self.retry_wait * attempt)

    # --- session ---
    def connect(self, keep_name: bool = False) -> None:
        """Signs in to the server: validates the token and starts the session (or resumes the one already active, if the agent restarted).
        `keep_name`: when resuming, keeps the session's nickname (another command, like --create-room, must not rename it)."""
        me = self._call("GET", "/me") or {}
        self._shared.cloud = bool(me.get("cloud"))
        current = me.get("session") or {}
        resume = current.get("id")
        name = current.get("display_name") if keep_name and resume else self.session_name
        body = {"display_name": name or self.session_name, **({"resume_id": resume} if resume else {}),
                **({"media_base": self.media_base} if self.media_base else {})}
        session = self._call("POST", "/sessions", body) or {}
        self._shared.session_id = session.get("id")
        log.info("sessão do agente ativa", extra={"session": self._shared.session_id, "resumed": bool(resume)})

    def create_room(self) -> dict:
        """Creates a Room in the session: { code, host_token, session_id }."""
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
        if not reply.get("session_id"):  # the server ended the session (a sweep): start another
            self.connect()
            self.publish_all()  # the new session starts knowing nothing of the songs: the catalog belongs to the device, but check it
        for video_id in list(self._shared.unpublished):  # what could not be published before (the network went down)
            self.publish_song(video_id)

    def _note_update(self, info: dict) -> None:
        """Keeps the server's version notice (for the interface) and logs it only when it changes."""
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

    # --- cloud (hybrid mode) ---
    @property
    def cloud_enabled(self) -> bool:
        return bool(self._shared.cloud and self._shared.storage is not None)

    def refresh_cloud(self) -> bool:
        """Asks the server whether this computer sends to the cloud (used by the short commands, like --import)."""
        self._shared.cloud = bool((self._call("GET", "/me") or {}).get("cloud"))
        return self._shared.cloud

    def _upload(self, video_id: str, name: str, data: bytes) -> None:
        request = urllib.request.Request(f"{self.base}/cloud/{video_id}/{name}", data=data, method="PUT", headers={
            "Authorization": f"Bearer {self.token}", "Content-Type": "application/octet-stream", "Accept": "application/json",
            "User-Agent": f"singalong-agent/{AGENT_VERSION}",
        })
        try:
            with self._open(request, timeout=300) as response:
                response.read()
        except urllib.error.HTTPError as exc:
            detail = _error_detail(exc)
            if exc.code == 401:
                raise AuthError(detail.get("message") or "token do agente recusado") from exc
            if exc.code >= 500 or exc.code == 429:
                raise BackendUnavailable(f"servidor respondeu {exc.code}") from exc
            raise Rejected(exc.code, str(detail.get("error", "")), str(detail.get("message", ""))) from exc
        except (urllib.error.URLError, TimeoutError, ConnectionError, OSError) as exc:
            raise BackendUnavailable(str(getattr(exc, "reason", exc))) from exc

    def cloud_sync(self, video_id: str) -> bool:
        """Uploads the song's files to the cloud (meta.json last: only with it does the song count as ready there).
        Does not resend what already went up and did not change. True if it sent anything."""
        storage = self._shared.storage
        if not self.cloud_enabled or storage is None or catalog.entry_for(storage, video_id) is None:
            return False
        base = f"cache/{video_id}"
        names = ["instrumental.mp3", "lyrics.json", *[n for n in ("melody.json", "backing.mp3") if storage.exists(f"{base}/{n}")], "meta.json"]
        sent = self._shared.cloud_sent.setdefault(video_id, {})
        if sent.get("blocked"):
            return False  # the admin took this song out of the cloud: do not insist (until the app restarts)
        uploaded = False
        for name in names:
            data = storage.read(f"{base}/{name}")
            signature = (len(data), hash(data))
            if sent.get(name) == signature:
                continue
            try:
                self._retry(lambda: self._upload(video_id, name, data), tries=3)
            except Rejected as exc:
                if exc.code != "cloud_blocked":
                    raise
                sent["blocked"] = True
                log.info("o administrador não quer esta música na nuvem", extra={"job": video_id})
                return False
            sent[name] = signature
            uploaded = True
        if uploaded:
            log.info("música enviada para a nuvem", extra={"job": video_id})
        return uploaded

    def cloud_backfill(self) -> int:
        """Sends what the cloud does not have yet from this computer's library. Returns how many songs went up."""
        storage = self._shared.storage
        if not self.cloud_enabled or storage is None:
            return 0
        ids = [entry["id"] for entry in catalog.scan(storage)]
        sent = 0
        for start in range(0, len(ids), 100):
            batch = ids[start:start + 100]
            missing = (self._retry(lambda: self._call("POST", "/cloud/missing", {"ids": batch})) or {}).get("missing", [])
            for video_id in missing:
                if self.cloud_sync(video_id):
                    sent += 1
        if sent:
            log.info("biblioteca enviada para a nuvem", extra={"songs": sent, "total": len(ids)})
        return sent

    def cloud_next(self, block_seconds: float) -> str | None:
        try:
            return self._shared.cloud_queue.get(timeout=max(0.1, block_seconds))
        except queue.Empty:
            return None

    # --- local catalog ---
    def publish_song(self, video_id: str, force: bool = False) -> None:
        """Publishes (or updates) a song in the cloud catalog. A network failure does not bring the job down: it waits for the next heartbeat.
        `force`: publishes even without a local media server in this process (the import command runs outside the agent)."""
        storage = self._shared.storage
        if self._shared.cloud:
            self._shared.cloud_queue.put(video_id)  # an allowed computer: the song (or its update) also goes up to the cloud
        if storage is None or (not force and not self._shared.media_base):
            return  # without a local media server, the cloud uses its own storage
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
        """Publishes the whole catalog (when the session starts): in batches, to fit each request's limit."""
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
        return []  # the server first delivers what was left with this device (in next_job)

    def reclaim(self, min_idle_seconds: float) -> list[Job]:
        return []  # likewise: the "no heartbeat" deadline is the server's

    def next_job(self, block_seconds: float) -> Job | None:
        data = self._claim("/jobs/claim", block_seconds)
        job = (data or {}).get("job")
        return Job(video_id=job["id"], payload=job["payload"], attempt=job.get("attempt")) if job else None

    def begin(self, job: Job) -> int:
        return int(job.attempt or 1)  # the server counts each delivery

    def set_state(self, job: Job, **fields) -> None:
        status = fields.pop("status", None)
        body = {name: _text(fields[name]) for name in JOB_FIELDS if name in fields}
        try:
            if status in TERMINAL:
                self._retry(lambda: self._call("POST", f"/jobs/{job.video_id}/complete", {"status": status, **body}))
            else:
                self._call("POST", f"/jobs/{job.video_id}/progress", body)
        except BackendUnavailable as exc:
            # losing a progress notice does not matter; losing the final one does (hence the retry above), but it does not bring the job down
            log.warning("não consegui avisar o servidor", extra={"job": job.video_id, "status": status, "reason": str(exc)})
        except Rejected as exc:
            log.warning("o servidor recusou o estado do job", extra={"job": job.video_id, "status": status, "code": exc.code})

    def finish(self, job: Job) -> None:
        return None  # the "complete" already acknowledged the job on the server

    # --- backing vocals: an internal queue (it does not go through the server) ---
    def request_backing(self, video_id: str) -> None:
        self._shared.backing.put(video_id)

    def next_backing(self, block_seconds: float) -> str | None:
        try:
            return self._shared.backing.get(timeout=max(0.1, block_seconds))
        except queue.Empty:
            return None

    # --- search ---
    def next_search(self, block_seconds: float) -> dict | None:
        return (self._claim("/search/claim", block_seconds) or {}).get("request")

    def reply_search(self, request_id: str, reply: dict) -> None:
        body = {"error": _text(reply["error"])} if reply.get("error") else {"results": reply.get("results", [])}
        try:
            self._retry(lambda: self._call("POST", f"/search/{request_id}/result", body))
        except (BackendUnavailable, Rejected) as exc:
            log.warning("não consegui devolver a busca", extra={"search": request_id, "reason": str(exc)})

    # --- export ---
    def next_export(self, block_seconds: float) -> dict | None:
        return (self._claim("/exports/claim", block_seconds) or {}).get("request")

    def set_export_state(self, video_id: str, pitch: int, status: str, error: str = "") -> None:
        try:
            self._retry(lambda: self._call("POST", f"/exports/{video_id}/{pitch}/state", {"status": status, **({"error": _text(error)} if error else {})}))
        except (BackendUnavailable, Rejected) as exc:
            log.warning("não consegui informar a exportação", extra={"job": video_id, "reason": str(exc)})


def pair(base_url: str, code: str, name: str = "Meu computador", opener=None, timeout: float = 20) -> dict:
    """Trades the pairing code for a device token: { device_id, token }. No authentication (the code is the secret)."""
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
    """The local agent (HTTP) if `AGENT_URL` is set; otherwise the classic worker (Redis)."""
    if agent_url:
        if not agent_token:
            raise ValueError("AGENT_URL exige AGENT_TOKEN (o token de dispositivo gerado no pareamento)")
        return HttpBackend(agent_url, agent_token, session_name)
    return RedisBackend(redis_url, consumer)
