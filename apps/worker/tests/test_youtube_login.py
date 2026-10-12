"""Login do YouTube pelo navegador do usuário (perfil dedicado + protocolo de depuração). Sem navegador real e sem rede."""
import json
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

from singalong_worker import youtube_login as yl
from singalong_worker.cookies import CookieSource

try:
    from websockets.sync.server import serve as ws_serve
except ImportError:  # a biblioteca só é exigida por quem usa o login
    ws_serve = None

SID = {"name": "SID", "value": "segredo", "domain": ".google.com", "path": "/", "secure": True, "httpOnly": True, "expires": 2_000_000_000}
PSID = {"name": "__Secure-3PSID", "value": "outro", "domain": ".youtube.com", "path": "/", "secure": True, "httpOnly": True, "expires": 2_000_000_000}
PREF = {"name": "PREF", "value": "x", "domain": ".youtube.com", "path": "/", "secure": False, "httpOnly": False, "expires": -1}
BANK = {"name": "session", "value": "nao-guardar", "domain": ".banco.example", "path": "/", "secure": True, "httpOnly": True, "expires": 2_000_000_000}


class TempDirCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)
        self.env = {"AGENT_DATA_DIR": str(self.dir / "dados")}

    def fake_exe(self, *parts):
        path = self.dir.joinpath(*parts)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"MZ")
        return path


class FindBrowserTests(TempDirCase):
    def test_o_caminho_explicito_vale_primeiro(self):
        exe = self.fake_exe("meu", "navegador.exe")
        self.assertEqual(yl.find_browser(env={"AGENT_BROWSER_PATH": str(exe)}), ("navegador", exe))

    def test_acha_o_chrome_e_o_edge_nas_pastas_do_windows_e_respeita_a_preferencia(self):
        chrome = self.fake_exe("PF", "Google", "Chrome", "Application", "chrome.exe")
        edge = self.fake_exe("PFx86", "Microsoft", "Edge", "Application", "msedge.exe")
        env = {"ProgramFiles": str(self.dir / "PF"), "ProgramFiles(x86)": str(self.dir / "PFx86")}
        find = lambda preferred, env: yl.find_browser(preferred, env, search_system=False)  # noqa: E731 - independe do que a máquina tem
        self.assertEqual(find(None, env), ("chrome", chrome))  # sem preferência: o Chrome primeiro
        self.assertEqual(find("edge", env), ("edge", edge))
        self.assertEqual(find("chrome", env), ("chrome", chrome))
        only_edge = {"ProgramFiles(x86)": str(self.dir / "PFx86")}
        self.assertEqual(find("chrome", only_edge), ("edge", edge))  # o preferido não existe: cai no outro

    def test_nenhum_instalado(self):
        self.assertIsNone(yl.find_browser(env={"ProgramFiles": str(self.dir / "vazio")}, search_system=False))


class CookieFilterTests(unittest.TestCase):
    def test_login_detectado_por_cookies_da_conta_do_google_ou_do_youtube(self):
        self.assertTrue(yl.is_logged_in([SID]))
        self.assertTrue(yl.is_logged_in([PREF, PSID]))
        self.assertFalse(yl.is_logged_in([PREF]))  # só preferências: não logado
        self.assertFalse(yl.is_logged_in([{**SID, "domain": ".banco.example"}]))  # SID de outro site não conta
        self.assertFalse(yl.is_logged_in([{**SID, "domain": ".evilgoogle.com"}]))  # nome que só TERMINA igual não é do Google
        self.assertFalse(yl.is_logged_in([{**PSID, "domain": "youtube.com.evil.example"}]))
        self.assertFalse(yl.is_logged_in([]))

    def test_so_guarda_o_que_e_do_youtube_e_do_google(self):
        kept = yl.relevant([SID, PSID, PREF, BANK, {**PREF, "domain": "accounts.google.com"}, {**PREF, "domain": "notyoutube.com"}])
        self.assertEqual({c["domain"] for c in kept}, {".google.com", ".youtube.com", "accounts.google.com"})
        self.assertNotIn(BANK, kept)


class FakeProc:
    def __init__(self):
        self.waited = self.killed = False

    def wait(self, timeout=None):
        self.waited = True

    def kill(self):
        self.killed = True


class FakeWs:
    """Responde ao protocolo de depuração: `steps` são as respostas sucessivas de Storage.getCookies (ou uma exceção)."""

    def __init__(self, steps):
        self.steps, self.sent, self.closed = list(steps), [], False
        self._reply = None

    def send(self, data):
        message = json.loads(data)
        self.sent.append(message["method"])
        if message["method"] == "Storage.getCookies":
            step = self.steps.pop(0) if len(self.steps) > 1 else self.steps[0]
            if isinstance(step, BaseException):
                raise step
            self._reply = {"id": message["id"], "result": {"cookies": step}}
        elif message["method"] == "Browser.close":
            self._reply = {"id": message["id"], "result": {}}
        else:
            self._reply = {"id": message["id"], "error": {"message": "método desconhecido"}}

    def recv(self, timeout=None):
        return json.dumps(self._reply)

    def close(self):
        self.closed = True


class LoginFlowTests(TempDirCase):
    def run_login(self, steps, **kw):
        exe = self.fake_exe("navegador.exe")
        self.env["AGENT_BROWSER_PATH"] = str(exe)
        self.ws = FakeWs(steps)
        self.proc = FakeProc()
        self.launched = []
        self.said = []
        clock = {"t": 0.0}

        def launcher(cmd, **kwargs):
            self.launched.append(cmd)
            return self.proc

        def now():
            clock["t"] += kw.pop("tick", 0.0) if False else 0.0
            return clock["t"]

        def sleep(seconds):
            clock["t"] += seconds

        return yl.login(env=self.env, say=self.said.append, launcher=launcher, discover=lambda port: f"ws://127.0.0.1:{port}/devtools/browser/x",
                        connect=lambda url, **kwargs: self.ws, sleep=sleep, now=now, poll=kw.get("poll", 2.0), timeout=kw.get("timeout", 600.0))

    def test_espera_o_login_grava_so_os_cookies_do_youtube_e_do_google_e_fecha_o_navegador(self):
        out = self.run_login([[PREF], [PREF], [SID, PSID, PREF, BANK], [SID, PSID, PREF, BANK]])
        self.assertEqual(out, self.dir / "dados" / "youtube_cookies.txt")
        text = out.read_text(encoding="utf-8")
        self.assertIn("SID", text)
        self.assertIn("__Secure-3PSID", text)
        self.assertNotIn("nao-guardar", text)  # cookie de outro site nunca é guardado
        self.assertIn("Browser.close", self.ws.sent)
        self.assertTrue(self.ws.closed)
        self.assertTrue(self.proc.waited)
        self.assertTrue(any("Login detectado" in line for line in self.said))

    def test_abre_o_navegador_com_o_perfil_dedicado_e_a_porta_de_depuracao(self):
        self.run_login([[SID, PSID], [SID, PSID]])
        (cmd,) = self.launched
        self.assertIn(f"--user-data-dir={self.dir / 'dados' / 'browser-profile'}", cmd)
        self.assertTrue(any(arg.startswith("--remote-debugging-port=") for arg in cmd))
        self.assertIn("--no-first-run", cmd)
        self.assertEqual(cmd[-1], yl.START_URL)
        self.assertTrue((self.dir / "dados" / "browser-profile").is_dir())

    def test_o_login_precisa_se_manter_por_um_instante_antes_de_gravar(self):
        # logo depois do login o YouTube ainda grava os últimos cookies: um cookie que some de novo reinicia a espera
        out = self.run_login([[SID], [PREF], [SID], [SID, PSID], [SID, PSID]])
        self.assertIn("__Secure-3PSID", out.read_text(encoding="utf-8"))

    def test_janela_fechada_antes_do_login(self):
        with self.assertRaises(yl.LoginError) as ctx:
            self.run_login([[PREF], ConnectionError("fechou")])
        self.assertIn("fechada", str(ctx.exception))
        self.assertTrue(self.proc.waited)  # mesmo assim limpa o processo

    def test_tempo_esgotado(self):
        with self.assertRaises(yl.LoginError) as ctx:
            self.run_login([[PREF]], timeout=10.0)
        self.assertIn("tempo", str(ctx.exception))

    def test_sem_navegador_instalado(self):
        original = yl.find_browser
        yl.find_browser = lambda *a, **k: None  # nenhum navegador, qualquer que seja a máquina
        try:
            with self.assertRaises(yl.LoginError) as ctx:
                yl.login(env={"AGENT_DATA_DIR": str(self.dir)}, say=lambda line: None, launcher=lambda *a, **k: self.fail("não devia abrir nada"))
        finally:
            yl.find_browser = original
        text = str(ctx.exception)
        self.assertIn("Não encontrei", text)
        self.assertIn("firefox", text)  # a mensagem aponta as alternativas

    def test_erro_do_protocolo_vira_login_error(self):
        cdp = yl.Cdp("ws://x", connect=lambda url, **kw: FakeWs([[]]))
        with self.assertRaises(yl.LoginError):
            cdp.call("Metodo.inexistente")


class CheckLoginTests(TempDirCase):
    def source(self):
        path = self.dir / "c.txt"
        path.write_text("# Netscape HTTP Cookie File\n", encoding="utf-8")
        return CookieSource(file=path)

    def test_conectado_quando_o_pedido_so_logado_funciona(self):
        seen = []
        state, detail = yl.check_login(self.source(), extract=lambda opts: seen.append(opts) or {"entries": []})
        self.assertEqual(state, "connected")
        self.assertIn("cookiefile", seen[0])
        self.assertEqual((seen[0]["extract_flat"], seen[0]["playlistend"]), ("in_playlist", 1))  # um pedido pequeno

    def test_sem_login_valido(self):
        def fail(opts):
            raise RuntimeError("ERROR: [youtube:tab] WL: YouTube said: The playlist does not exist.")

        self.assertEqual(yl.check_login(self.source(), extract=fail)[0], "not-logged")

    def test_falha_de_rede_nao_vira_sem_login(self):
        def fail(opts):
            raise OSError("Temporary failure in name resolution")

        state, detail = yl.check_login(self.source(), extract=fail)
        self.assertEqual(state, "error")
        self.assertIn("name resolution", detail)

    def test_sem_fonte(self):
        self.assertEqual(yl.check_login(None)[0], "no-source")

    def test_comando_status(self):
        said = []
        self.assertEqual(yl.main_status(None, said.append), 1)
        self.assertIn("--youtube-login", said[0])
        original = yl.check_login
        try:
            yl.check_login = lambda source: ("connected", "arquivo x")
            self.assertEqual(yl.main_status(self.source(), said.append), 0)
            self.assertIn("Conectado", said[-1])
            yl.check_login = lambda source: ("not-logged", "vencida")
            self.assertEqual(yl.main_status(self.source(), said.append), 1)
        finally:
            yl.check_login = original


class DiscoverTests(unittest.TestCase):
    def test_descobre_o_endereco_websocket_pelo_json_version(self):
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                body = json.dumps({"Browser": "Chrome/155", "webSocketDebuggerUrl": "ws://127.0.0.1:1/devtools/browser/abc"}).encode()
                self.send_response(200)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args):
                pass

        server = HTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.assertEqual(yl.discover_ws_url(server.server_address[1], timeout=5), "ws://127.0.0.1:1/devtools/browser/abc")

    def test_navegador_que_nao_responde(self):
        with self.assertRaises(yl.LoginError):
            yl.discover_ws_url(yl.free_port(), timeout=0.5)  # ninguém escuta nessa porta


@unittest.skipIf(ws_serve is None, "precisa da biblioteca websockets (pip install websockets)")
class RealWebSocketTests(unittest.TestCase):
    """O cliente do protocolo de depuração contra um servidor WebSocket de verdade."""

    def test_le_os_cookies_e_fecha_o_navegador(self):
        received = []

        def handler(ws):
            for raw in ws:
                message = json.loads(raw)
                received.append(message["method"])
                result = {"cookies": [SID, PSID]} if message["method"] == "Storage.getCookies" else {}
                ws.send(json.dumps({"id": message["id"], "result": result}))
                if message["method"] == "Browser.close":
                    return

        with ws_serve(handler, "127.0.0.1", 0) as server:
            threading.Thread(target=server.serve_forever, daemon=True).start()
            port = server.socket.getsockname()[1]
            cdp = yl.Cdp(f"ws://127.0.0.1:{port}/devtools/browser/x")
            self.assertEqual([c["name"] for c in cdp.cookies()], ["SID", "__Secure-3PSID"])
            cdp.close()
            server.shutdown()
        self.assertEqual(received, ["Storage.getCookies", "Browser.close"])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
