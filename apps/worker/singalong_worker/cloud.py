"""Automatic upload of the songs to the cloud (hybrid mode): if this computer was paired with an e-mail the server allows
(ENABLED_TO_SEND_TO_CLOUD), every song that becomes ready, and those already in the library, go up to the server, and any
Room plays them without downloading them from YouTube again. It runs on its own thread: a slow upload never holds the next job."""
import logging
import threading

from .backend import AuthError, BackendUnavailable, Rejected

log = logging.getLogger("worker.cloud")

RETRY_SECONDS = 60  # if the server was down, try what was missing again later


def serve(backend, storage, stop: threading.Event) -> None:
    """First sends what the cloud does not have yet (the library that already existed); then each song as it becomes ready."""
    backend.attach_storage(storage)
    backfilled = False
    while not stop.is_set():
        try:
            if not backend.cloud_enabled:
                stop.wait(5)  # not allowed (or no session yet): just wait; the heartbeat updates the state
                continue
            if not backfilled:
                backend.cloud_backfill()
                backfilled = True
            video_id = backend.cloud_next(1.0)
            if video_id:
                backend.cloud_sync(video_id)
        except (BackendUnavailable, Rejected, AuthError) as exc:
            log.warning("envio para a nuvem falhou, tentando de novo depois", extra={"reason": str(exc)})
            backfilled = False
            stop.wait(RETRY_SECONDS)
