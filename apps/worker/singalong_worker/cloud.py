"""Envio automático das músicas para a nuvem (modo híbrido): se este computador foi pareado com um e-mail autorizado pelo servidor
(ENABLED_TO_SEND_TO_CLOUD), cada música pronta, e as que já estavam na biblioteca, sobem para o servidor, e qualquer sala passa a
tocá-las sem baixar de novo do YouTube. Roda numa thread própria: um envio demorado nunca segura o próximo job."""
import logging
import threading

from .backend import AuthError, BackendUnavailable, Rejected

log = logging.getLogger("worker.cloud")

RETRY_SECONDS = 60  # se o servidor estava fora do ar, tenta o que faltava de novo depois


def serve(backend, storage, stop: threading.Event) -> None:
    """Primeiro envia o que a nuvem ainda não tem (a biblioteca que já existia); depois, cada música que fica pronta."""
    backend.attach_storage(storage)
    backfilled = False
    while not stop.is_set():
        try:
            if not backend.cloud_enabled:
                stop.wait(5)  # sem autorização (ou sem sessão ainda): só espera; o sinal de vida atualiza o estado
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
