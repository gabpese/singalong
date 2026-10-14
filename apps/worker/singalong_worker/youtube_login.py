"""Login do YouTube do agente, pelo navegador que o usuário já tem (Chrome ou Edge), sem janela embutida no app.

Por que assim (TRD, seção 8): o Google bloqueia o login em navegadores embutidos (Electron etc.), e no Windows o Chrome e o Edge
criptografam os cookies de um jeito que o recurso `--cookies-from-browser` do yt-dlp costuma não conseguir ler. Em vez disso:

  1. abre o navegador do usuário com um PERFIL DEDICADO do agente (pasta própria, a conta pessoal do usuário não é tocada);
  2. o usuário entra na conta do YouTube nessa janela (a recomendação é uma conta secundária, só para isso);
  3. o agente pede os cookies ao PRÓPRIO navegador pelo protocolo de depuração (CDP), que já os entrega descriptografados;
  4. grava um cookies.txt (só do usuário, nunca enviado a ninguém) e fecha o navegador: sem a janela aberta, o YouTube não gira
     os cookies, e a sessão exportada continua valendo.

A validação (`check_login`) faz um pedido que só funciona logado (a playlist "Assistir mais tarde"). Os cookies nunca saem do
computador.
"""
import json
import logging
import os
import socket
import subprocess
import time
import urllib.request
from collections.abc import Callable
from pathlib import Path

from .cookies import CookieSource, data_dir, ytdlp_options, write_netscape

log = logging.getLogger("worker.login")

LOGIN_COOKIE_NAMES = ("SID", "__Secure-3PSID", "__Secure-1PSID")  # basta um deles: a conta está logada
KEEP_DOMAINS = ("youtube.com", "google.com")
START_URL = "https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F"
WATCH_LATER = "https://www.youtube.com/playlist?list=WL"
PROFILE_DIR_NAME = "browser-profile"


class LoginError(Exception):
    """O login não pôde ser concluído; a mensagem diz o que fazer."""


def _env(env, name: str) -> str | None:
    """Uma variável de ambiente; no Windows os nomes não diferenciam maiúsculas (e uma cópia de os.environ perde isso)."""
    return env.get(name) or next((value for key, value in env.items() if key.upper() == name.upper() and value), None)


def find_browser(preferred: str | None = None, env=os.environ, search_system: bool = True) -> tuple[str, Path] | None:
    """O Chrome ou o Edge instalados: (nome, caminho). `AGENT_BROWSER_PATH` aponta um executável específico.
    `search_system=False` ignora os caminhos fixos do macOS e do Linux (os testes não podem depender do que a máquina tem)."""
    explicit = _env(env, "AGENT_BROWSER_PATH")
    if explicit and Path(explicit).is_file():
        return "navegador", Path(explicit)
    system_paths = {
        "chrome": [
            Path("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
            Path("/usr/bin/google-chrome"), Path("/usr/bin/google-chrome-stable"), Path("/opt/google/chrome/chrome"),
            Path("/usr/bin/chromium"), Path("/usr/bin/chromium-browser"),  # o Chromium do snap não serve: o perfil do agente fica numa pasta oculta que ele não lê
        ],
        "edge": [
            Path("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
            Path("/usr/bin/microsoft-edge"), Path("/usr/bin/microsoft-edge-stable"), Path("/opt/microsoft/msedge/msedge"),
        ],
    }
    program_files = [Path(path) for path in (_env(env, name) for name in ("ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA")) if path]
    candidates = {
        "chrome": [p / "Google/Chrome/Application/chrome.exe" for p in program_files]
        + (system_paths["chrome"] if search_system else []),
        "edge": [p / "Microsoft/Edge/Application/msedge.exe" for p in program_files]
        + (system_paths["edge"] if search_system else []),
    }
    order = [preferred, *[n for n in candidates if n != preferred]] if preferred in candidates else ["chrome", "edge"]
    for name in order:
        for path in candidates[name]:
            if path.is_file():
                return name, path
    return None


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def discover_ws_url(port: int, timeout: float = 20.0) -> str:
    """O endereço WebSocket do navegador (o protocolo de depuração sobe alguns instantes depois de ele abrir)."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/version", timeout=2) as response:
                return json.load(response)["webSocketDebuggerUrl"]
        except (OSError, ValueError, KeyError):
            time.sleep(0.3)
    raise LoginError("O navegador abriu, mas não respondeu ao agente. Feche as janelas do perfil do agente e tente de novo.")


def _is_google_or_youtube(domain: str) -> bool:
    """O domínio é o do YouTube/Google ou um subdomínio dele (e não um nome que só TERMINA igual, como "notyoutube.com")."""
    host = domain.lstrip(".").lower()
    return any(host == d or host.endswith("." + d) for d in KEEP_DOMAINS)


def is_logged_in(cookies: list[dict]) -> bool:
    return any(c["name"] in LOGIN_COOKIE_NAMES and _is_google_or_youtube(c["domain"]) for c in cookies)


def relevant(cookies: list[dict]) -> list[dict]:
    """Só os cookies do YouTube e do Google (o resto do navegador não interessa e não é guardado)."""
    return [c for c in cookies if _is_google_or_youtube(c["domain"])]


class Cdp:
    """Um cliente mínimo do protocolo de depuração do Chrome/Edge sobre WebSocket (síncrono)."""

    def __init__(self, ws_url: str, connect: Callable | None = None):
        if connect is None:
            from websockets.sync.client import connect  # import tardio: só o login precisa da biblioteca
        self.ws = connect(ws_url, open_timeout=10, max_size=32 * 1024 * 1024)
        self._id = 0

    def call(self, method: str, params: dict | None = None, timeout: float = 10.0) -> dict:
        self._id += 1
        self.ws.send(json.dumps({"id": self._id, "method": method, "params": params or {}}))
        while True:
            message = json.loads(self.ws.recv(timeout=timeout))
            if message.get("id") == self._id:
                if "error" in message:
                    raise LoginError(f"O navegador recusou {method}: {message['error'].get('message')}")
                return message.get("result", {})

    def cookies(self) -> list[dict]:
        return self.call("Storage.getCookies")["cookies"]

    def close(self) -> None:
        try:
            self.call("Browser.close", timeout=3)
        except Exception:  # noqa: BLE001 - o navegador fecha a conexão ao sair
            pass
        try:
            self.ws.close()
        except Exception:  # noqa: BLE001
            pass


def login(
    browser: str | None = None,
    env=os.environ,
    say: Callable[[str], None] = print,
    timeout: float = 600.0,
    poll: float = 2.0,
    launcher: Callable = subprocess.Popen,
    discover: Callable[[int], str] = discover_ws_url,
    connect: Callable | None = None,
    sleep: Callable[[float], None] = time.sleep,
    now: Callable[[], float] = time.monotonic,
) -> Path:
    """Abre o navegador com o perfil do agente, espera o usuário entrar no YouTube e grava o cookies.txt. Devolve o caminho."""
    found = find_browser(browser, env)
    if not found:
        raise LoginError(
            "Não encontrei o Chrome nem o Edge neste computador. Instale um deles, ou use YTDLP_COOKIES_BROWSER=firefox "
            "(com o Firefox já logado no YouTube) ou YTDLP_COOKIES=<cookies.txt exportado>."
        )
    name, exe = found
    folder = data_dir(env)
    profile = folder / PROFILE_DIR_NAME
    profile.mkdir(parents=True, exist_ok=True)
    out_file = folder / "youtube_cookies.txt"
    port = free_port()
    say(f"Vou abrir o {name} com um perfil só do Singalong. Entre na conta do YouTube que o agente deve usar")
    say("(recomendo uma conta secundária, só para isso) e aguarde: a janela fecha sozinha quando o login for detectado.")
    proc = launcher([str(exe), f"--user-data-dir={profile}", f"--remote-debugging-port={port}", "--no-first-run",
                     "--no-default-browser-check", START_URL], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    cdp = None
    try:
        cdp = Cdp(discover(port), connect)
        deadline = now() + timeout
        seen_since: float | None = None
        while True:
            if now() > deadline:
                raise LoginError("Passou o tempo para entrar no YouTube. Rode o comando de novo.")
            try:
                cookies = cdp.cookies()
            except Exception as exc:  # noqa: BLE001 - a janela foi fechada antes de o login terminar
                raise LoginError("A janela do navegador foi fechada antes de o login terminar. Rode o comando de novo.") from exc
            if is_logged_in(cookies):
                # espera um instante: logo depois do login o YouTube ainda grava os últimos cookies da sessão
                seen_since = seen_since if seen_since is not None else now()
                if now() - seen_since >= poll:
                    count = write_netscape(out_file, relevant(cookies))
                    say(f"Login detectado: {count} cookies guardados em {out_file}")
                    return out_file
            else:
                seen_since = None
            sleep(poll)
    finally:
        if cdp:
            cdp.close()
        try:
            proc.wait(timeout=10)
        except Exception:  # noqa: BLE001 - não fechou sozinho: encerra
            try:
                proc.kill()
            except Exception:  # noqa: BLE001
                pass


class _Silent:
    """Logger do yt-dlp que não imprime nada: a validação devolve o resultado em vez de poluir o terminal com "ERROR:"."""

    def debug(self, message):  # noqa: D102
        pass

    warning = error = info = debug


def check_login(source: CookieSource | None, workdir: Path | None = None, extract: Callable | None = None) -> tuple[str, str]:
    """Confere se a conta está logada: ("connected" | "not-logged" | "no-source" | "error", detalhe).

    Faz UM pedido que só funciona logado (a playlist "Assistir mais tarde"); sem login o YouTube responde que ela não existe.
    """
    if source is None:
        return "no-source", "nenhum login configurado"
    import tempfile

    with tempfile.TemporaryDirectory(prefix="singalong-login-") as tmp:
        try:
            opts = {"quiet": True, "no_warnings": True, "skip_download": True, "extract_flat": "in_playlist", "playlistend": 1,
                    "socket_timeout": 20, "logger": _Silent(), **ytdlp_options(source, workdir or Path(tmp))}
            if extract is None:
                import yt_dlp

                def extract(options: dict):  # noqa: E306
                    with yt_dlp.YoutubeDL(options) as ydl:
                        return ydl.extract_info(WATCH_LATER, download=False)

            extract(opts)
            return "connected", source.describe()
        except Exception as exc:  # noqa: BLE001 - o texto do erro diz se é falta de login ou de rede
            text = str(exc).lower()
            if "playlist does not exist" in text or "sign in" in text or "login" in text:
                return "not-logged", "o YouTube não reconhece a sessão (vencida ou nunca iniciada)"
            return "error", f"{type(exc).__name__}: {str(exc)[:160]}"


def main_status(source: CookieSource | None, say: Callable[[str], None] = print) -> int:
    """Comando --youtube-status: 0 se conectado."""
    state, detail = check_login(source)
    messages = {
        "connected": f"Conectado ({detail}).",
        "not-logged": f"Sem login válido: {detail}. Rode: python -m singalong_worker --youtube-login",
        "no-source": "Nenhum login do YouTube configurado. Rode: python -m singalong_worker --youtube-login",
        "error": f"Não consegui verificar o login: {detail}",
    }
    say(messages[state])
    return 0 if state == "connected" else 1

