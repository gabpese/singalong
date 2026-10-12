"""Servidor local de mídia e catálogo da biblioteca local: sem rede externa (só o loopback desta máquina)."""
import json
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from singalong_worker import catalog
from singalong_worker.media_server import MediaServer, download_name, parse_range
from singalong_worker.storage import LocalStorage

VID = "abcdefghijk"
ORIGIN = "https://singalong.example"
AUDIO = bytes(range(256)) * 40  # 10 240 bytes


def make_song(root: Path, vid: str = VID, extra: tuple = ()) -> None:
    folder = root / "cache" / vid
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "instrumental.mp3").write_bytes(AUDIO)
    (folder / "lyrics.json").write_text('[{"start":1,"end":2,"text":"oi"}]', encoding="utf-8")
    (folder / "meta.json").write_text(json.dumps({"video_id": vid, "title": "Tempo Perdido", "artist": "Legião Urbana", "duration": 300}), encoding="utf-8")
    (folder / "vocals.mp3").write_bytes(b"segredo: a voz isolada nao e servida")
    (folder / "source.json").write_text('{"url":"x"}', encoding="utf-8")
    for name in extra:
        (folder / name).write_bytes(b"x" * 100)


class MediaServerTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        make_song(self.root, extra=("melody.json", "backing.mp3", "karaoke.mp4", "karaoke_p+2.mp4", "karaoke_p-3.mp4"))
        self.server = MediaServer(self.root, [ORIGIN], port=0, token="tok123")
        self.base = self.server.start()
        self.addCleanup(self.server.stop)
        self.addCleanup(self.tmp.cleanup)

    def request(self, path, method="GET", headers=None, base=None):
        req = urllib.request.Request((base or self.base.rsplit("/", 1)[0]) + path, method=method, headers=headers or {})
        try:
            with urllib.request.urlopen(req, timeout=5) as response:
                return response.status, dict(response.headers), response.read()
        except urllib.error.HTTPError as exc:
            body = exc.read()
            exc.close()
            return exc.code, dict(exc.headers), body

    def media(self, name, vid=VID, **kw):
        return self.request(f"/tok123/cache/{vid}/{name}", **kw)

    def test_o_endereco_tem_o_token_e_a_porta_escolhida(self):
        self.assertRegex(self.base, r"^http://127\.0\.0\.1:\d+/tok123$")

    def test_serve_o_arquivo_inteiro_com_cors_e_aceita_range(self):
        status, headers, body = self.media("instrumental.mp3", headers={"Origin": ORIGIN})
        self.assertEqual((status, body), (200, AUDIO))
        self.assertEqual(headers["Access-Control-Allow-Origin"], ORIGIN)
        self.assertEqual((headers["Vary"], headers["Accept-Ranges"], headers["Content-Type"]), ("Origin", "bytes", "audio/mpeg"))
        self.assertIn("Content-Range", headers["Access-Control-Expose-Headers"])
        self.assertEqual(headers["Cross-Origin-Resource-Policy"], "cross-origin")
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")

    def test_pedidos_range_para_saltar_no_audio(self):
        status, headers, body = self.media("instrumental.mp3", headers={"Range": "bytes=100-199"})
        self.assertEqual((status, body, headers["Content-Range"]), (206, AUDIO[100:200], f"bytes 100-199/{len(AUDIO)}"))
        status, headers, body = self.media("instrumental.mp3", headers={"Range": "bytes=10000-"})  # até o fim
        self.assertEqual((status, body), (206, AUDIO[10000:]))
        status, _, body = self.media("instrumental.mp3", headers={"Range": "bytes=-50"})  # os últimos 50 bytes
        self.assertEqual((status, body), (206, AUDIO[-50:]))
        status, _, body = self.media("instrumental.mp3", headers={"Range": "bytes=0-999999"})  # fim além do arquivo
        self.assertEqual((status, len(body)), (206, len(AUDIO)))
        for bad in ("bytes=99999-", "bytes=5-2", "bytes=-", "bytes=-0", "items=0-1", "bytes=0-1,5-6"):
            self.assertEqual(self.media("instrumental.mp3", headers={"Range": bad})[0], 416, bad)

    def test_head_nao_manda_o_corpo(self):
        status, headers, body = self.media("instrumental.mp3", method="HEAD")
        self.assertEqual((status, body, headers["Content-Length"]), (200, b"", str(len(AUDIO))))

    def test_preflight_cors(self):
        status, headers, _ = self.media("lyrics.json", method="OPTIONS", headers={"Origin": ORIGIN, "Access-Control-Request-Method": "GET"})
        self.assertEqual(status, 204)
        self.assertEqual(headers["Access-Control-Allow-Origin"], ORIGIN)
        self.assertIn("range", headers["Access-Control-Allow-Headers"])
        self.assertEqual(headers["Access-Control-Allow-Private-Network"], "true")
        self.assertEqual(self.media("lyrics.json", method="OPTIONS", headers={"Origin": "https://outro.example"})[0], 403)

    def test_origem_de_outro_site_e_recusada_mas_sem_origem_vale(self):
        self.assertEqual(self.media("instrumental.mp3", headers={"Origin": "https://evil.example"})[0], 403)
        self.assertEqual(self.media("instrumental.mp3", headers={"Origin": "http://localhost:3000"})[0], 403)  # não está na lista
        status, headers, _ = self.media("instrumental.mp3")  # navegação direta / <audio> sem CORS
        self.assertEqual(status, 200)
        self.assertNotIn("Access-Control-Allow-Origin", headers)

    def test_so_serve_os_arquivos_da_lista(self):
        for name in ("instrumental.mp3", "lyrics.json", "melody.json", "backing.mp3", "karaoke.mp4", "karaoke_p+2.mp4", "karaoke_p-3.mp4"):
            self.assertEqual(self.media(name)[0], 200, name)
        for name in ("vocals.mp3", "source.json", "meta.json", "karaoke_p+9.mp4", "karaoke_p2.mp4", "outro.txt", ".env", "instrumental.mp3.tmp"):
            self.assertEqual(self.media(name)[0], 404, name)  # a voz isolada nunca sai do computador

    def test_token_errado_e_tentativas_de_sair_da_pasta(self):
        self.assertEqual(self.request(f"/errado/cache/{VID}/instrumental.mp3")[0], 404)
        self.assertEqual(self.request(f"/cache/{VID}/instrumental.mp3")[0], 404)  # sem token
        for path in (
            f"/tok123/cache/../cache/{VID}/instrumental.mp3", f"/tok123/cache/%2e%2e/{VID}/instrumental.mp3",
            f"/tok123/cache/{VID}/..%2finstrumental.mp3", f"/tok123/cache/{VID}%2f..%2f..%2fx/instrumental.mp3",
            "/tok123/cache/curto/instrumental.mp3", f"/tok123/cache/{VID}/", "/tok123/cache", "/tok123/", "/", "/tok123/..",
            f"/tok123/cache/{VID}/instrumental.mp3/extra",
        ):
            self.assertEqual(self.request(path)[0], 404, path)

    def test_so_get_head_e_options(self):
        for method in ("POST", "PUT", "DELETE", "PATCH"):
            status, headers, _ = self.request(f"/tok123/cache/{VID}/instrumental.mp3", method=method)
            self.assertEqual((status, headers.get("Allow")), (405, "GET, HEAD, OPTIONS"), method)

    def test_sonda_ping_para_a_tv_acionar_a_permissao_de_rede_local(self):
        status, headers, body = self.request("/tok123/ping", headers={"Origin": ORIGIN})
        self.assertEqual((status, json.loads(body)), (200, {"ok": True}))
        self.assertEqual(headers["Access-Control-Allow-Origin"], ORIGIN)
        self.assertEqual(self.request("/outro/ping")[0], 404)

    def test_musica_importada_com_id_f_hash(self):
        make_song(self.root, "f-0123456789ab")
        self.assertEqual(self.media("instrumental.mp3", vid="f-0123456789ab")[0], 200)
        self.assertEqual(self.media("instrumental.mp3", vid="f-zzzzzzzzzzzz")[0], 404)

    def test_link_simbolico_para_fora_da_pasta_nao_e_seguido(self):
        outside = Path(tempfile.mkdtemp())
        self.addCleanup(lambda: [p.unlink() for p in outside.iterdir()] and outside.rmdir() if outside.exists() else None)
        (outside / "segredo.mp3").write_bytes(b"fora")
        link = self.root / "cache" / "linkzinho00" / "instrumental.mp3"
        link.parent.mkdir(parents=True)
        try:
            link.symlink_to(outside / "segredo.mp3")
        except (OSError, NotImplementedError):
            self.skipTest("o sistema não permite criar links simbólicos sem privilégio")
        self.assertEqual(self.media("instrumental.mp3", vid="linkzinho00")[0], 404)

    def test_download_pede_ao_navegador_para_baixar_com_o_nome_sugerido(self):
        # a página está em outra origem: o atributo `download` não vale, então o servidor manda `Content-Disposition`
        status, headers, body = self.media("karaoke_p+2.mp4?download=Legi%C3%A3o%20-%20Tempo%20Perdido%20(%2B2).mp4")
        self.assertEqual((status, len(body)), (200, 100))
        self.assertEqual(headers["Content-Disposition"], "attachment; filename*=UTF-8''Legi%C3%A3o%20-%20Tempo%20Perdido%20%28%2B2%29.mp4")
        self.assertNotIn("Content-Disposition", self.media("karaoke.mp4")[1])
        self.assertNotIn("Content-Disposition", self.media("karaoke.mp4?download=")[1])
        # o nome não pode escapar da pasta de downloads nem quebrar o cabeçalho
        status, headers, _ = self.media("karaoke.mp4?download=..%2F..%2Fx%0D%0AInjetado%3A%20sim.mp4")
        self.assertEqual(status, 200)
        self.assertNotIn("Injetado", "".join(headers.keys()))
        self.assertNotIn("/", headers["Content-Disposition"].split("''", 1)[1])

    def test_download_name(self):
        self.assertEqual(download_name("AC/DC - Who Made Who?.mp4"), "AC DC - Who Made Who .mp4")
        self.assertEqual(download_name("  a" + chr(9) + "b" + chr(10) + "c  "), "a b c")
        self.assertIsNone(download_name(""))
        self.assertIsNone(download_name(None))
        self.assertIsNone(download_name('***'))
        self.assertEqual(len(download_name("x" * 500)), 120)

    def test_parse_range(self):
        self.assertIsNone(parse_range(None, 100))
        self.assertEqual(parse_range("bytes=0-9", 100), (0, 9))
        self.assertEqual(parse_range("bytes=90-", 100), (90, 99))
        self.assertEqual(parse_range("bytes=-10", 100), (90, 99))
        self.assertEqual(parse_range("bytes=-500", 100), (0, 99))
        self.assertEqual(parse_range("bytes=0-500", 100), (0, 99))
        self.assertEqual(parse_range("bytes=100-", 100), "invalid")


class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.storage = LocalStorage(self.root)
        self.addCleanup(self.tmp.cleanup)

    def test_entrada_de_uma_musica_pronta_com_so_o_basico(self):
        make_song(self.root)
        entry = catalog.entry_for(self.storage, VID)
        self.assertEqual(entry["id"], VID)
        self.assertEqual(entry["meta"]["title"], "Tempo Perdido")
        self.assertEqual(entry["files"], {"instrumental": True, "lyrics": True, "melody": False, "backing": False, "exports": []})

    def test_arquivos_opcionais_e_os_tons_exportados(self):
        make_song(self.root, extra=("melody.json", "backing.mp3", "karaoke.mp4", "karaoke_p+2.mp4", "karaoke_p-3.mp4", "karaoke_p+x.mp4", "karaoke_p+9.mp4.tmp"))
        files = catalog.entry_for(self.storage, VID)["files"]
        self.assertEqual((files["melody"], files["backing"], files["exports"]), (True, True, [-3, 0, 2]))

    def test_musica_incompleta_ou_invalida_nao_entra(self):
        folder = self.root / "cache" / VID
        folder.mkdir(parents=True)
        (folder / "instrumental.mp3").write_bytes(b"x")  # sem letra nem meta: job interrompido
        self.assertIsNone(catalog.entry_for(self.storage, VID))
        self.assertIsNone(catalog.entry_for(self.storage, "inexistente0"))
        self.assertIsNone(catalog.entry_for(self.storage, "../etc/passwd"))
        make_song(self.root, "bbbbbbbbbbb")
        (self.root / "cache" / "bbbbbbbbbbb" / "meta.json").write_text("{ não é json", encoding="utf-8")
        self.assertIsNone(catalog.entry_for(self.storage, "bbbbbbbbbbb"))
        (self.root / "cache" / "bbbbbbbbbbb" / "meta.json").write_text(json.dumps({"x": "y" * 30_000}), encoding="utf-8")
        self.assertIsNone(catalog.entry_for(self.storage, "bbbbbbbbbbb"))  # grande demais para o servidor

    def test_scan_lista_so_as_prontas_em_ordem(self):
        make_song(self.root, "ccccccccccc")
        make_song(self.root, "aaaaaaaaaaa")
        make_song(self.root, "f-0123456789ab")
        (self.root / "cache" / "ddddddddddd").mkdir(parents=True)
        (self.root / "cache" / "ddddddddddd" / "meta.json").write_text("{}", encoding="utf-8")  # sem instrumental: não está pronta
        self.assertEqual([e["id"] for e in catalog.scan(self.storage)], ["aaaaaaaaaaa", "ccccccccccc", "f-0123456789ab"])


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
