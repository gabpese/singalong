"""Versão do app (agente): um número só, lido pelo agente, pelo heartbeat e pelo instalador (MAIOR.MENOR.CORREÇÃO)."""
import json
import os
import re
import urllib.parse
import urllib.request

__version__ = "0.3.0"

_VERSION_RE = re.compile(r"^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:[-+][0-9A-Za-z.-]{0,40})?$")


def current_version() -> str:
    """A versão deste app; SINGALONG_AGENT_VERSION sobrescreve (testes e builds de teste)."""
    return os.environ.get("SINGALONG_AGENT_VERSION") or __version__


def parse(value) -> tuple[int, int, int] | None:
    match = _VERSION_RE.match(str(value or "").strip())
    return tuple(int(part) for part in match.groups()) if match else None  # type: ignore[return-value]


def is_older(a, b) -> bool:
    """True se a < b (False quando alguma das duas não é uma versão)."""
    x, y = parse(a), parse(b)
    return bool(x and y and x < y)


def check_update(server_url: str, current: str | None = None, timeout: float = 10) -> dict | None:
    """Pergunta ao servidor se há versão nova (endpoint aberto, antes mesmo de parear). Devolve
    { status: ok|update_available|update_required|unknown, latest, minimum, notes, url } ou None se não deu para consultar."""
    current = current or current_version()
    url = f"{server_url.rstrip('/')}/agent/v1/version?{urllib.parse.urlencode({'current': current})}"
    try:
        request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": f"singalong-agent/{current}"})
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read())
    except (OSError, ValueError):
        return None
