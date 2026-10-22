"""YouTube cookies: when to use the account and where they come from.

Policy (decided in the TRD, section 8): the download tries **without a cookie first**, over the user's own connection, and
uses the account **only when YouTube asks** (a login, a "not a robot" check, an age restriction, a 403). That keeps the
account barely exposed (yt-dlp warns that using an account with it can get the account restricted). The choices, set by
`YTDLP_COOKIES_POLICY`:

  when-asked  (default) no cookie first; the cookie only when YouTube asks for a login;
  always      always with the account (more risk to it);
  never       never uses cookies.

Where the cookies come from (the first source that exists):
  1. `YTDLP_COOKIES`          a cookies.txt file (Netscape format);
  2. `YTDLP_COOKIES_BROWSER`  the browser, through yt-dlp's own feature (`firefox`, `chrome:Profile`...). On Windows, Chrome and
                              Edge encrypt cookies in a way yt-dlp often cannot read: prefer the login below;
  3. the agent's login file (`--youtube-login`, in youtube_login.py), in `AGENT_DATA_DIR` (default ~/.singalong).
The cookies never leave this computer.
"""
import logging
import os
import shutil
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .errors import classify

log = logging.getLogger("worker.cookies")

MODES = ("when-asked", "always", "never")
# failures worth retrying with the account: a login/robot request, an age restriction and the download's 403
LOGIN_CODES = frozenset({"cookies", "age", "forbidden"})
LOGIN_FILE_NAME = "youtube_cookies.txt"


@dataclass(frozen=True)
class CookieSource:
    """Where the cookies come from: a file (cookies.txt) or a browser (a yt-dlp spec: "firefox" or "chrome:Profile")."""

    file: Path | None = None
    browser: str | None = None

    def describe(self) -> str:
        return f"arquivo {self.file}" if self.file else f"navegador {self.browser}"


@dataclass(frozen=True)
class CookiePolicy:
    mode: str = "when-asked"
    source: CookieSource | None = None


def data_dir(env=os.environ) -> Path:
    """The agent's folder (the login's browser profile and its cookies.txt)."""
    return Path(env.get("AGENT_DATA_DIR") or Path.home() / ".singalong")


def login_cookie_file(env=os.environ) -> Path:
    return data_dir(env) / LOGIN_FILE_NAME


def load_policy(env=os.environ) -> CookiePolicy:
    """The cookie policy and source, from the environment variables."""
    mode = (env.get("YTDLP_COOKIES_POLICY") or "when-asked").strip().lower()
    if mode not in MODES:
        log.warning("YTDLP_COOKIES_POLICY=%r inválida (use %s): usando when-asked", mode, ", ".join(MODES))
        mode = "when-asked"
    source: CookieSource | None = None
    configured = env.get("YTDLP_COOKIES")
    if configured and Path(configured).is_file():
        source = CookieSource(file=Path(configured))
    elif configured:
        log.warning("YTDLP_COOKIES aponta para um arquivo que não existe (%s): ignorando", configured)
    if source is None and env.get("YTDLP_COOKIES_BROWSER"):
        source = CookieSource(browser=env["YTDLP_COOKIES_BROWSER"].strip())
    if source is None and login_cookie_file(env).is_file():
        source = CookieSource(file=login_cookie_file(env))
    return CookiePolicy(mode, source)


def as_policy(value: Any) -> CookiePolicy:
    """Accepts a policy, a cookies.txt path (explicit: always used) or None (no cookies)."""
    if isinstance(value, CookiePolicy):
        return value
    if value:
        return CookiePolicy("always", CookieSource(file=Path(value)))
    return CookiePolicy("never", None)


def ytdlp_options(source: CookieSource, workdir: Path) -> dict:
    """yt-dlp's options to use this cookie source."""
    if source.browser:
        parts = [part or None for part in source.browser.split(":", 1)]
        return {"cookiesfrombrowser": tuple(parts)}
    # yt-dlp rewrites the file when it closes: use a copy, so the original can be read-only
    copy = workdir / "cookies.txt"
    shutil.copyfile(source.file, copy)
    return {"cookiefile": str(copy)}


def needs_login(exc: BaseException) -> bool:
    """Did YouTube refuse for lack of a login (and not because of the video)?"""
    return classify(exc).code in LOGIN_CODES


def run_with_policy(policy: CookiePolicy, attempt: Callable[[dict], Any], workdir: Path) -> Any:
    """Runs `attempt(cookie_options)` by the policy: no cookie first and, if YouTube asks for a login, with the account."""
    if policy.mode == "never" or policy.source is None:
        return attempt({})
    if policy.mode == "always":
        return attempt(ytdlp_options(policy.source, workdir))
    try:
        return attempt({})
    except Exception as exc:  # noqa: BLE001 - só repete se for pedido de login; o resto sobe como estava
        if not needs_login(exc):
            raise
        log.info("o YouTube pediu login: tentando de novo com a conta", extra={"code": classify(exc).code})
        return attempt(ytdlp_options(policy.source, workdir))


def write_netscape(path: Path, cookies: list[dict]) -> int:
    """Writes cookies (in the Chrome/Edge debugging protocol's format) as yt-dlp's cookies.txt. Returns how many."""
    lines = ["# Netscape HTTP Cookie File", "# Gerado pelo agente do Singalong. Não compartilhe: dá acesso à conta."]
    for c in cookies:
        domain = str(c["domain"])
        if c.get("httpOnly"):
            domain = f"#HttpOnly_{domain}"
        expires = int(c["expires"]) if float(c.get("expires", -1)) > 0 else 0  # a session cookie = 0
        lines.append("\t".join([
            domain, "TRUE" if str(c["domain"]).startswith(".") else "FALSE", c.get("path", "/") or "/",
            "TRUE" if c.get("secure") else "FALSE", str(expires), str(c["name"]), str(c["value"]),
        ]))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    try:
        os.chmod(path, 0o600)  # only the owner reads it (on Windows the user folder's permission applies)
    except OSError:
        pass
    return len(cookies)
