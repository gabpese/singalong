"""YouTube login through the user's browser (a dedicated profile + the debugging protocol). No real browser and no network."""
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
except ImportError:  # the library is required only by whoever uses the login
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
    def test_the_explicit_path_comes_first(self):
        exe = self.fake_exe("meu", "navegador.exe")
        self.assertEqual(yl.find_browser(env={"AGENT_BROWSER_PATH": str(exe)}), ("navegador", exe))

    def test_finds_chrome_and_edge_in_the_windows_folders_and_respects_the_preference(self):
        chrome = self.fake_exe("PF", "Google", "Chrome", "Application", "chrome.exe")
        edge = self.fake_exe("PFx86", "Microsoft", "Edge", "Application", "msedge.exe")
        env = {"ProgramFiles": str(self.dir / "PF"), "ProgramFiles(x86)": str(self.dir / "PFx86")}
        find = lambda preferred, env: yl.find_browser(preferred, env, search_system=False)  # noqa: E731 - independe do que a máquina tem
        self.assertEqual(find(None, env), ("chrome", chrome))  # no preference: Chrome first
        self.assertEqual(find("edge", env), ("edge", edge))
        self.assertEqual(find("chrome", env), ("chrome", chrome))
        only_edge = {"ProgramFiles(x86)": str(self.dir / "PFx86")}
        self.assertEqual(find("chrome", only_edge), ("edge", edge))  # the preferred one does not exist: falls back to the other

    def test_none_installed(self):
        self.assertIsNone(yl.find_browser(env={"ProgramFiles": str(self.dir / "vazio")}, search_system=False))


class CookieFilterTests(unittest.TestCase):
    def test_login_detected_by_google_or_youtube_account_cookies(self):
        self.assertTrue(yl.is_logged_in([SID]))
        self.assertTrue(yl.is_logged_in([PREF, PSID]))
        self.assertFalse(yl.is_logged_in([PREF]))  # only preferences: not logged in
        self.assertFalse(yl.is_logged_in([{**SID, "domain": ".banco.example"}]))  # a SID from another site does not count
        self.assertFalse(yl.is_logged_in([{**SID, "domain": ".evilgoogle.com"}]))  # a name that only ENDS the same is not Google's
        self.assertFalse(yl.is_logged_in([{**PSID, "domain": "youtube.com.evil.example"}]))
        self.assertFalse(yl.is_logged_in([]))

    def test_keeps_only_youtube_and_google_cookies(self):
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
    """Answers the debugging protocol: `steps` are the successive answers of Storage.getCookies (or an exception)."""

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

    def test_waits_for_the_login_writes_only_youtube_and_google_cookies_and_closes_the_browser(self):
        out = self.run_login([[PREF], [PREF], [SID, PSID, PREF, BANK], [SID, PSID, PREF, BANK]])
        self.assertEqual(out, self.dir / "dados" / "youtube_cookies.txt")
        text = out.read_text(encoding="utf-8")
        self.assertIn("SID", text)
        self.assertIn("__Secure-3PSID", text)
        self.assertNotIn("nao-guardar", text)  # a cookie from another site is never kept
        self.assertIn("Browser.close", self.ws.sent)
        self.assertTrue(self.ws.closed)
        self.assertTrue(self.proc.waited)
        self.assertTrue(any("Login detectado" in line for line in self.said))

    def test_opens_the_browser_with_the_dedicated_profile_and_the_debugging_port(self):
        self.run_login([[SID, PSID], [SID, PSID]])
        (cmd,) = self.launched
        self.assertIn(f"--user-data-dir={self.dir / 'dados' / 'browser-profile'}", cmd)
        self.assertTrue(any(arg.startswith("--remote-debugging-port=") for arg in cmd))
        self.assertIn("--no-first-run", cmd)
        self.assertEqual(cmd[-1], yl.START_URL)
        self.assertTrue((self.dir / "dados" / "browser-profile").is_dir())

    def test_the_login_must_hold_for_a_moment_before_writing(self):
        # right after the login YouTube still writes its last cookies: a cookie that disappears again restarts the wait
        out = self.run_login([[SID], [PREF], [SID], [SID, PSID], [SID, PSID]])
        self.assertIn("__Secure-3PSID", out.read_text(encoding="utf-8"))

    def test_window_closed_before_the_login(self):
        with self.assertRaises(yl.LoginError) as ctx:
            self.run_login([[PREF], ConnectionError("fechou")])
        self.assertIn("fechada", str(ctx.exception))
        self.assertTrue(self.proc.waited)  # still cleans up the process

    def test_timeout(self):
        with self.assertRaises(yl.LoginError) as ctx:
            self.run_login([[PREF]], timeout=10.0)
        self.assertIn("tempo", str(ctx.exception))

    def test_no_browser_installed(self):
        original = yl.find_browser
        yl.find_browser = lambda *a, **k: None  # no browser, whatever the machine
        try:
            with self.assertRaises(yl.LoginError) as ctx:
                yl.login(env={"AGENT_DATA_DIR": str(self.dir)}, say=lambda line: None, launcher=lambda *a, **k: self.fail("não devia abrir nada"))
        finally:
            yl.find_browser = original
        text = str(ctx.exception)
        self.assertIn("Não encontrei", text)
        self.assertIn("firefox", text)  # the message points to the alternatives

    def test_a_protocol_error_becomes_login_error(self):
        cdp = yl.Cdp("ws://x", connect=lambda url, **kw: FakeWs([[]]))
        with self.assertRaises(yl.LoginError):
            cdp.call("Metodo.inexistente")


class CheckLoginTests(TempDirCase):
    def source(self):
        path = self.dir / "c.txt"
        path.write_text("# Netscape HTTP Cookie File\n", encoding="utf-8")
        return CookieSource(file=path)

    def test_connected_when_the_logged_in_only_request_works(self):
        seen = []
        state, detail = yl.check_login(self.source(), extract=lambda opts: seen.append(opts) or {"entries": []})
        self.assertEqual(state, "connected")
        self.assertIn("cookiefile", seen[0])
        self.assertEqual((seen[0]["extract_flat"], seen[0]["playlistend"]), ("in_playlist", 1))  # a small request

    def test_no_valid_login(self):
        def fail(opts):
            raise RuntimeError("ERROR: [youtube:tab] WL: YouTube said: The playlist does not exist.")

        self.assertEqual(yl.check_login(self.source(), extract=fail)[0], "not-logged")

    def test_a_network_failure_does_not_become_not_logged_in(self):
        def fail(opts):
            raise OSError("Temporary failure in name resolution")

        state, detail = yl.check_login(self.source(), extract=fail)
        self.assertEqual(state, "error")
        self.assertIn("name resolution", detail)

    def test_no_source(self):
        self.assertEqual(yl.check_login(None)[0], "no-source")

    def test_status_command(self):
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
    def test_discovers_the_websocket_address_through_json_version(self):
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

    def test_a_browser_that_does_not_answer(self):
        with self.assertRaises(yl.LoginError):
            yl.discover_ws_url(yl.free_port(), timeout=0.5)  # nobody listens on that port


@unittest.skipIf(ws_serve is None, "precisa da biblioteca websockets (pip install websockets)")
class RealWebSocketTests(unittest.TestCase):
    """The debugging protocol's client against a real WebSocket server."""

    def test_reads_the_cookies_and_closes_the_browser(self):
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
