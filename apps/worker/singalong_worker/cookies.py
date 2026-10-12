"""Cookies do YouTube: quando usar a conta e de onde vêm.

Política (decidida no TRD, seção 8): o download tenta **sem cookie primeiro**, pela internet do próprio usuário, e usa a conta
**só quando o YouTube pedir** (login, confirmação de "não sou um robô", restrição de idade, 403). Assim a conta fica pouco
exposta (o yt-dlp avisa que usar uma conta com ele pode levá-la a ser restringida). Escolhas, por `YTDLP_COOKIES_POLICY`:

  when-asked  (padrão) sem cookie primeiro; com cookie só quando o YouTube pedir login;
  always      sempre com a conta (mais risco para ela);
  never       nunca usa cookies.

De onde vêm os cookies (a primeira fonte que existir):
  1. `YTDLP_COOKIES`          um arquivo cookies.txt (formato Netscape);
  2. `YTDLP_COOKIES_BROWSER`  o navegador, pelo recurso nativo do yt-dlp (`firefox`, `chrome:Perfil`...). No Windows, o Chrome e o
                              Edge criptografam os cookies de um jeito que o yt-dlp costuma não conseguir ler: prefira o login abaixo;
  3. o arquivo do login do agente (`--youtube-login`, em youtube_login.py), em `AGENT_DATA_DIR` (padrão ~/.singalong).
Os cookies nunca saem deste computador.
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
# falhas em que vale tentar de novo com a conta: pedido de login/robô, restrição de idade e o 403 do download
LOGIN_CODES = frozenset({"cookies", "age", "forbidden"})
LOGIN_FILE_NAME = "youtube_cookies.txt"


@dataclass(frozen=True)
class CookieSource:
    """De onde vêm os cookies: um arquivo (cookies.txt) ou um navegador (spec do yt-dlp: "firefox" ou "chrome:Perfil")."""

    file: Path | None = None
    browser: str | None = None

    def describe(self) -> str:
        return f"arquivo {self.file}" if self.file else f"navegador {self.browser}"


@dataclass(frozen=True)
class CookiePolicy:
    mode: str = "when-asked"
    source: CookieSource | None = None


def data_dir(env=os.environ) -> Path:
    """A pasta do agente (perfil do navegador do login e o cookies.txt dele)."""
    return Path(env.get("AGENT_DATA_DIR") or Path.home() / ".singalong")


def login_cookie_file(env=os.environ) -> Path:
    return data_dir(env) / LOGIN_FILE_NAME


def load_policy(env=os.environ) -> CookiePolicy:
    """A política e a fonte de cookies, pelas variáveis de ambiente."""
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
    """Aceita uma política, um caminho de cookies.txt (explícito: sempre usa) ou None (sem cookies)."""
    if isinstance(value, CookiePolicy):
        return value
    if value:
        return CookiePolicy("always", CookieSource(file=Path(value)))
    return CookiePolicy("never", None)


def ytdlp_options(source: CookieSource, workdir: Path) -> dict:
    """As opções do yt-dlp para usar esta fonte de cookies."""
    if source.browser:
        parts = [part or None for part in source.browser.split(":", 1)]
        return {"cookiesfrombrowser": tuple(parts)}
    # o yt-dlp regrava o arquivo ao fechar: usa uma cópia para o original poder ser somente leitura
    copy = workdir / "cookies.txt"
    shutil.copyfile(source.file, copy)
    return {"cookiefile": str(copy)}


def needs_login(exc: BaseException) -> bool:
    """O YouTube recusou por falta de login (e não por culpa do vídeo)?"""
    return classify(exc).code in LOGIN_CODES


def run_with_policy(policy: CookiePolicy, attempt: Callable[[dict], Any], workdir: Path) -> Any:
    """Roda `attempt(opções_de_cookie)` conforme a política: sem cookie primeiro e, se o YouTube pedir login, com a conta."""
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
    """Grava cookies (no formato do protocolo de depuração do Chrome/Edge) como cookies.txt do yt-dlp. Devolve quantos."""
    lines = ["# Netscape HTTP Cookie File", "# Gerado pelo agente do Singalong. Não compartilhe: dá acesso à conta."]
    for c in cookies:
        domain = str(c["domain"])
        if c.get("httpOnly"):
            domain = f"#HttpOnly_{domain}"
        expires = int(c["expires"]) if float(c.get("expires", -1)) > 0 else 0  # cookie de sessão = 0
        lines.append("\t".join([
            domain, "TRUE" if str(c["domain"]).startswith(".") else "FALSE", c.get("path", "/") or "/",
            "TRUE" if c.get("secure") else "FALSE", str(expires), str(c["name"]), str(c["value"]),
        ]))
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    try:
        os.chmod(path, 0o600)  # só o dono lê (no Windows vale a permissão da pasta do usuário)
    except OSError:
        pass
    return len(cookies)
