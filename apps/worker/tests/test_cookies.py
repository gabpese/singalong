"""Política de cookies do YouTube: sem cookie primeiro, a conta só quando o YouTube pedir login (TRD, seção 8)."""
import http.cookiejar
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from singalong_worker import cookies as ck
from singalong_worker import pipeline, search
from singalong_worker.cookies import CookiePolicy, CookieSource

BOT = RuntimeError("ERROR: [youtube] abc: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies")
AGE = RuntimeError("ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users.")
FORBIDDEN = RuntimeError("ERROR: unable to download video data: HTTP Error 403: Forbidden")
PRIVATE = RuntimeError("ERROR: [youtube] abc: Private video. Sign in if you've been granted access to this video")
GONE = RuntimeError("ERROR: [youtube] abc: Video unavailable")
NETWORK = RuntimeError("urlopen error [Errno -3] Temporary failure in name resolution")


class TempDirCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def cookie_file(self, name="cookies.txt"):
        path = self.dir / name
        path.write_text("# Netscape HTTP Cookie File\n", encoding="utf-8")
        return path


class LoadPolicyTests(TempDirCase):
    def env(self, **values):
        return {"AGENT_DATA_DIR": str(self.dir / "dados"), **values}

    def test_padrao_e_sem_cookie_primeiro_e_sem_fonte(self):
        policy = ck.load_policy(self.env())
        self.assertEqual((policy.mode, policy.source), ("when-asked", None))

    def test_o_modo_aceita_maiusculas_e_espacos_e_recusa_o_invalido(self):
        self.assertEqual(ck.load_policy(self.env(YTDLP_COOKIES_POLICY="  ALWAYS ")).mode, "always")
        self.assertEqual(ck.load_policy(self.env(YTDLP_COOKIES_POLICY="never")).mode, "never")
        self.assertEqual(ck.load_policy(self.env(YTDLP_COOKIES_POLICY="talvez")).mode, "when-asked")

    def test_a_ordem_das_fontes_arquivo_navegador_login_do_agente(self):
        file = self.cookie_file()
        login = self.dir / "dados" / "youtube_cookies.txt"
        login.parent.mkdir()
        login.write_text("x", encoding="utf-8")
        both = ck.load_policy(self.env(YTDLP_COOKIES=str(file), YTDLP_COOKIES_BROWSER="firefox"))
        self.assertEqual(both.source, CookieSource(file=file))
        browser = ck.load_policy(self.env(YTDLP_COOKIES_BROWSER=" firefox "))
        self.assertEqual(browser.source, CookieSource(browser="firefox"))
        self.assertEqual(ck.load_policy(self.env()).source, CookieSource(file=login))  # o login do agente é a reserva

    def test_arquivo_configurado_que_nao_existe_e_ignorado(self):
        policy = ck.load_policy(self.env(YTDLP_COOKIES=str(self.dir / "nao-existe.txt"), YTDLP_COOKIES_BROWSER="firefox"))
        self.assertEqual(policy.source, CookieSource(browser="firefox"))
        self.assertIsNone(ck.load_policy(self.env(YTDLP_COOKIES=str(self.dir / "nao-existe.txt"))).source)

    def test_pasta_do_agente(self):
        self.assertEqual(ck.data_dir({"AGENT_DATA_DIR": "/x/y"}), Path("/x/y"))
        self.assertEqual(ck.data_dir({}), Path.home() / ".singalong")
        self.assertEqual(ck.login_cookie_file({"AGENT_DATA_DIR": "/x"}), Path("/x/youtube_cookies.txt"))

    def test_as_policy(self):
        policy = CookiePolicy("always", None)
        self.assertIs(ck.as_policy(policy), policy)
        path = self.cookie_file()
        self.assertEqual(ck.as_policy(path), CookiePolicy("always", CookieSource(file=path)))  # caminho explícito = sempre usa
        self.assertEqual(ck.as_policy(None), CookiePolicy("never", None))


class OptionsTests(TempDirCase):
    def test_arquivo_vira_uma_copia_e_o_original_fica_intacto(self):
        original = self.cookie_file()
        work = self.dir / "work"
        work.mkdir()
        opts = ck.ytdlp_options(CookieSource(file=original), work)
        self.assertEqual(opts, {"cookiefile": str(work / "cookies.txt")})
        self.assertEqual((work / "cookies.txt").read_text(encoding="utf-8"), original.read_text(encoding="utf-8"))
        (work / "cookies.txt").write_text("regravado pelo yt-dlp", encoding="utf-8")
        self.assertEqual(original.read_text(encoding="utf-8"), "# Netscape HTTP Cookie File\n")

    def test_navegador_vira_a_tupla_do_yt_dlp(self):
        self.assertEqual(ck.ytdlp_options(CookieSource(browser="firefox"), self.dir), {"cookiesfrombrowser": ("firefox",)})
        self.assertEqual(ck.ytdlp_options(CookieSource(browser="chrome:Profile 1"), self.dir), {"cookiesfrombrowser": ("chrome", "Profile 1")})
        self.assertEqual(ck.ytdlp_options(CookieSource(browser="chrome:"), self.dir), {"cookiesfrombrowser": ("chrome", None)})


class NeedsLoginTests(unittest.TestCase):
    def test_so_o_que_o_login_pode_resolver(self):
        for exc in (BOT, AGE, FORBIDDEN):
            self.assertTrue(ck.needs_login(exc), str(exc))
        for exc in (PRIVATE, GONE, NETWORK, KeyError("x")):
            self.assertFalse(ck.needs_login(exc), str(exc))


class RunWithPolicyTests(TempDirCase):
    def setUp(self):
        super().setUp()
        self.source = CookieSource(file=self.cookie_file())
        self.work = self.dir / "work"
        self.work.mkdir()
        self.calls = []

    def attempt(self, *results):
        results = list(results)

        def run(opts):
            self.calls.append(dict(opts))
            result = results.pop(0)
            if isinstance(result, BaseException):
                raise result
            return result

        return run

    def test_nunca_e_sem_fonte_nunca_usam_cookie(self):
        for policy in (CookiePolicy("never", self.source), CookiePolicy("when-asked", None), CookiePolicy("always", None)):
            self.calls.clear()
            self.assertEqual(ck.run_with_policy(policy, self.attempt("ok"), self.work), "ok")
            self.assertEqual(self.calls, [{}], policy)
        with self.assertRaises(RuntimeError):
            ck.run_with_policy(CookiePolicy("when-asked", None), self.attempt(BOT), self.work)  # sem conta, o erro sobe

    def test_sempre_usa_a_conta_logo_na_primeira(self):
        self.assertEqual(ck.run_with_policy(CookiePolicy("always", self.source), self.attempt("ok"), self.work), "ok")
        self.assertEqual(len(self.calls), 1)
        self.assertIn("cookiefile", self.calls[0])

    def test_quando_pedir_funcionou_sem_cookie_nem_toca_na_conta(self):
        self.assertEqual(ck.run_with_policy(CookiePolicy("when-asked", self.source), self.attempt("ok"), self.work), "ok")
        self.assertEqual(self.calls, [{}])

    def test_quando_pedir_repete_com_a_conta_so_se_o_youtube_pedir_login(self):
        for failure in (BOT, AGE, FORBIDDEN):
            self.calls.clear()
            self.assertEqual(ck.run_with_policy(CookiePolicy("when-asked", self.source), self.attempt(failure, "ok"), self.work), "ok")
            self.assertEqual(len(self.calls), 2, str(failure))
            self.assertEqual(self.calls[0], {})
            self.assertIn("cookiefile", self.calls[1])

    def test_outras_falhas_sobem_sem_gastar_a_conta(self):
        for failure in (PRIVATE, GONE, NETWORK):
            self.calls.clear()
            with self.assertRaises(RuntimeError):
                ck.run_with_policy(CookiePolicy("when-asked", self.source), self.attempt(failure), self.work)
            self.assertEqual(self.calls, [{}], str(failure))

    def test_se_a_conta_tambem_falha_sobe_o_erro_da_segunda_tentativa(self):
        second = RuntimeError("ERROR: [youtube] abc: Sign in to confirm you’re not a bot (de novo)")
        with self.assertRaises(RuntimeError) as ctx:
            ck.run_with_policy(CookiePolicy("when-asked", self.source), self.attempt(BOT, second), self.work)
        self.assertIs(ctx.exception, second)

    def test_navegador_como_fonte(self):
        policy = CookiePolicy("when-asked", CookieSource(browser="firefox"))
        ck.run_with_policy(policy, self.attempt(BOT, "ok"), self.work)
        self.assertEqual(self.calls[1], {"cookiesfrombrowser": ("firefox",)})


class DownloadAndSearchFollowThePolicyTests(TempDirCase):
    def test_download_tenta_sem_cookie_e_repete_com_a_conta_quando_o_youtube_pede(self):
        source = CookieSource(file=self.cookie_file())
        work = self.dir / "work"
        work.mkdir()
        with mock.patch.object(pipeline, "_download", side_effect=[BOT, {"audio": "x"}]) as inner:
            result = pipeline.download("https://www.youtube.com/watch?v=abcdefghijk", work, ["pt"], CookiePolicy("when-asked", source), 900)
        self.assertEqual(result, {"audio": "x"})
        first, second = (call.args[3] for call in inner.call_args_list)  # o 4º argumento são as opções de cookie
        self.assertEqual(first, {})
        self.assertIn("cookiefile", second)

    def test_download_com_caminho_explicito_usa_a_conta_sempre(self):
        work = self.dir / "work"
        work.mkdir()
        with mock.patch.object(pipeline, "_download", return_value={}) as inner:
            pipeline.download("u", work, ["pt"], self.cookie_file(), 900)
        self.assertIn("cookiefile", inner.call_args.args[3])

    def test_busca_segue_a_mesma_politica(self):
        seen = []

        class FakeYoutubeDL:
            def __init__(self, opts):
                seen.append(dict(opts))
                self.opts = opts

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def extract_info(self, query, download=False):
                if "cookiefile" not in self.opts:
                    raise BOT
                return {"entries": [{"id": "abcdefghijk", "title": "T", "channel": "C", "duration": 10}]}

        fake = SimpleNamespace(YoutubeDL=FakeYoutubeDL)
        policy = CookiePolicy("when-asked", CookieSource(file=self.cookie_file()))
        with mock.patch.dict(sys.modules, {"yt_dlp": fake}):
            results = search.search_youtube("legiao urbana", policy)
        self.assertEqual(results[0]["video_id"], "abcdefghijk")
        self.assertEqual(["cookiefile" in opts for opts in seen], [False, True])  # sem cookie primeiro, depois com a conta


class NetscapeTests(TempDirCase):
    COOKIES = [
        {"name": "SID", "value": "abc", "domain": ".youtube.com", "path": "/", "secure": True, "httpOnly": True, "expires": 2_000_000_000.5},
        {"name": "PREF", "value": "x=y", "domain": "www.youtube.com", "path": "/", "secure": False, "httpOnly": False, "expires": -1},
        {"name": "LOGIN_INFO", "value": "li", "domain": ".google.com", "path": "/accounts", "secure": True, "httpOnly": False, "expires": 1_900_000_000},
    ]

    def test_formato_do_cookies_txt(self):
        path = self.dir / "sub" / "youtube_cookies.txt"
        self.assertEqual(ck.write_netscape(path, self.COOKIES), 3)
        lines = path.read_text(encoding="utf-8").splitlines()
        self.assertEqual(lines[0], "# Netscape HTTP Cookie File")
        rows = [line.split("\t") for line in lines if not line.startswith("# ")]
        self.assertEqual(rows[0], ["#HttpOnly_.youtube.com", "TRUE", "/", "TRUE", "2000000000", "SID", "abc"])  # HttpOnly e subdomínios
        self.assertEqual(rows[1], ["www.youtube.com", "FALSE", "/", "FALSE", "0", "PREF", "x=y"])  # sem ponto no domínio; sessão = 0
        self.assertEqual(rows[2][:6], [".google.com", "TRUE", "/accounts", "TRUE", "1900000000", "LOGIN_INFO"])

    def test_o_yt_dlp_consegue_ler_o_arquivo(self):
        path = self.dir / "c.txt"
        ck.write_netscape(path, self.COOKIES)
        jar = http.cookiejar.MozillaCookieJar(str(path))
        jar.load(ignore_discard=True, ignore_expires=True)
        names = {c.name: c for c in jar}
        self.assertEqual({"SID", "PREF", "LOGIN_INFO"}, set(names))
        self.assertEqual((names["SID"].value, names["SID"].secure, names["SID"].domain), ("abc", True, ".youtube.com"))

    @unittest.skipIf(os.name == "nt", "permissões POSIX")
    def test_so_o_dono_le_o_arquivo(self):
        path = self.dir / "c.txt"
        ck.write_netscape(path, self.COOKIES)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
