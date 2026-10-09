"""Falhas do processamento traduzidas para o que a pessoa entende e para o que fazer a respeito.

`retry` diz o que vale a pena depois da falha:
  - "auto"   falha transitória (rede, limite de pedidos do YouTube): o worker tenta de novo sozinho, com espera;
  - "manual" pode dar certo se a pessoa (ou quem administra) resolver algo antes: aparece "Tentar de novo";
  - "never"  não adianta repetir (vídeo privado, removido...): só resta escolher outro vídeo.
"""
import errno
import subprocess
from dataclasses import dataclass

AUTO, MANUAL, NEVER = "auto", "manual", "never"


class JobError(Exception):
    """Falha já traduzida: `code` (estável, para a tela), `message` (para a pessoa) e `retry`."""

    def __init__(self, code: str, message: str, retry: str = MANUAL):
        super().__init__(message)
        self.code = code
        self.message = message
        self.retry = retry


@dataclass(frozen=True)
class _Rule:
    code: str
    retry: str
    message: str
    patterns: tuple[str, ...]  # trechos (minúsculos) que identificam a falha no texto do erro


# A ordem importa: a primeira regra que casa vence. Os textos vêm do yt-dlp, do ffmpeg e do Demucs.
_RULES = (
    _Rule("cookies", MANUAL,
          "O YouTube pediu para confirmar que não sou um robô: os cookies do YouTube venceram. "
          "Renove o arquivo secrets/youtube_cookies.txt e tente de novo.",
          ("not a bot", "use --cookies-from-browser", "cookies are no longer valid", "login required")),
    _Rule("private", NEVER, "Este vídeo é privado. Escolha outro vídeo.",
          ("private video", "this video is private")),
    _Rule("copyright", NEVER, "O YouTube bloqueou este vídeo por direitos autorais. Escolha outra versão da música.",
          ("blocked it on copyright", "who has blocked it", "copyright grounds")),
    _Rule("geo", NEVER, "Este vídeo não está disponível no seu país. Escolha outra versão da música.",
          ("not available in your country", "available in your country", "geo restriction", "geo-restricted")),
    _Rule("age", NEVER, "Este vídeo tem restrição de idade e não pode ser baixado. Escolha outra versão da música.",
          ("confirm your age", "age-restricted", "age restricted", "inappropriate for some users")),
    _Rule("members", NEVER, "Este vídeo é só para membros do canal. Escolha outro vídeo.",
          ("members-only", "members only", "join this channel", "available to this channel's members")),
    _Rule("live", NEVER, "Este vídeo é uma transmissão ao vivo (ou uma estreia agendada) e ainda não pode ser baixado.",
          ("live event will begin", "premieres in", "this live event", "is live")),
    _Rule("unavailable", NEVER, "Este vídeo não está mais disponível no YouTube. Escolha outra versão da música.",
          ("video unavailable", "this video is unavailable", "has been removed", "no longer available", "does not exist",
           "account associated with this video has been terminated", "this video isn't available")),
    _Rule("rate_limited", AUTO,
          "O YouTube limitou os pedidos por excesso de requisições. Vou tentar de novo; se continuar, espere alguns minutos.",
          ("http error 429", "too many requests")),
    _Rule("network", AUTO, "Falha de conexão com o YouTube. Vou tentar de novo.",
          ("temporary failure in name resolution", "connection reset", "connection refused", "connection aborted",
           "network is unreachable", "timed out", "remote end closed", "unable to download webpage", "http error 5",
           "ssl:", "bad gateway", "service unavailable", "eof occurred")),
    _Rule("format", MANUAL,
          "O YouTube não ofereceu um formato de áudio utilizável. Atualizar o yt-dlp (reconstruir a imagem do worker) costuma resolver.",
          ("requested format is not available", "no video formats found", "unable to extract", "nsig extraction")),
    _Rule("gpu_memory", MANUAL,
          "A placa de vídeo ficou sem memória para separar a voz. Feche outros programas que usam a GPU e tente de novo.",
          ("out of memory",)),
    _Rule("disk_full", MANUAL, "Sem espaço em disco para processar a música. Libere espaço e tente de novo.",
          ("no space left on device",)),
)


def classify(exc: BaseException) -> JobError:
    """Traduz qualquer exceção do processamento em um JobError (devolve o mesmo se já for um)."""
    if isinstance(exc, JobError):
        return exc
    if isinstance(exc, OSError) and exc.errno == errno.ENOSPC:
        return JobError("disk_full", "Sem espaço em disco para processar a música. Libere espaço e tente de novo.", MANUAL)
    if isinstance(exc, subprocess.TimeoutExpired):
        return JobError("timeout", "O processamento demorou demais e foi interrompido. Tente de novo.", MANUAL)
    text = str(exc).lower()
    for rule in _RULES:
        if any(pattern in text for pattern in rule.patterns):
            return JobError(rule.code, rule.message, rule.retry)
    if isinstance(exc, subprocess.CalledProcessError):
        return JobError("audio", "Falha ao converter ou separar o áudio da música. Tente de novo.", MANUAL)
    return JobError("unknown", f"Erro inesperado ({type(exc).__name__}: {str(exc)[:200]}). Tente de novo.", MANUAL)


def format_duration(seconds: float) -> str:
    """'3 min 20 s', '1 h 05 min' — para as mensagens de limite."""
    total = int(round(seconds))
    hours, rest = divmod(total, 3600)
    minutes, secs = divmod(rest, 60)
    if hours:
        return f"{hours} h {minutes:02d} min"
    return f"{minutes} min {secs:02d} s" if minutes else f"{secs} s"
