"""The app's (agent's) version: one number, read by the agent, the heartbeat and the installer (MAJOR.MINOR.PATCH)."""
import json
import os
import re
import urllib.parse
import urllib.request

__version__ = "1.4.2"

_VERSION_RE = re.compile(r"^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:[-+][0-9A-Za-z.-]{0,40})?$")


def current_version() -> str:
    """This app's version; SINGALONG_AGENT_VERSION overrides it (tests and test builds)."""
    return os.environ.get("SINGALONG_AGENT_VERSION") or __version__


def parse(value) -> tuple[int, int, int] | None:
    match = _VERSION_RE.match(str(value or "").strip())
    return tuple(int(part) for part in match.groups()) if match else None  # type: ignore[return-value]


def is_older(a, b) -> bool:
    """True if a < b (False when either one is not a version)."""
    x, y = parse(a), parse(b)
    return bool(x and y and x < y)


def check_update(server_url: str, current: str | None = None, timeout: float = 10) -> dict | None:
    """Asks the server whether there is a new version (an open endpoint, even before pairing). Returns
    { status: ok|update_available|update_required|unknown, latest, minimum, notes, url }, or None if it could not ask."""
    current = current or current_version()
    url = f"{server_url.rstrip('/')}/agent/v1/version?{urllib.parse.urlencode({'current': current})}"
    try:
        request = urllib.request.Request(url, headers={"Accept": "application/json", "User-Agent": f"singalong-agent/{current}"})
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return json.loads(response.read())
    except (OSError, ValueError):
        return None
