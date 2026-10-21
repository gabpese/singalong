"""Importing songs without YouTube: the user's file and open sources. No ffmpeg, no network and no Demucs (test doubles)."""
import hashlib
import io
import json
import re
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from singalong_worker import cli, importer, pipeline
from singalong_worker.errors import JobError
from singalong_worker.importer import ImportedSong
from singalong_worker.pipeline import Limits, NeedsLyrics
from singalong_worker.storage import LocalStorage

try:
    import yt_dlp
except ImportError:  # CI installs it; on a machine without it the test is skipped
    yt_dlp = None

LIMITS = Limits(max_duration=900.0, min_free_gb=0, separate_timeout=None)


class TempDirCase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.dir = Path(self.tmp.name)

    def audio_file(self, name="musica.mp3", content=b"conteudo de audio"):
        path = self.dir / name
        path.write_bytes(content)
        return path


def probe_json(duration="200.5", tags=None, streams=None):
    streams = streams if streams is not None else [{"codec_type": "audio", "codec_name": "mp3"}]
    return json.dumps({"streams": streams, "format": {"duration": duration, "tags": tags or {}}})


def fake_run(probe=None, probe_code=0, decode_ok=True):
    """A fake subprocess.run: ffprobe returns `probe`; ffmpeg creates the target wav (the last argument)."""
    calls = []

    def run(cmd, **kwargs):
        calls.append(list(cmd))
        if cmd[0] == "ffprobe":
            return SimpleNamespace(returncode=probe_code, stdout=probe if probe is not None else probe_json(), stderr="")
        if decode_ok:
            Path(cmd[-1]).write_bytes(b"RIFFwav")
        return SimpleNamespace(returncode=0 if decode_ok else 1, stdout="", stderr="erro do ffmpeg")

    run.calls = calls
    return run


class FileIdTests(TempDirCase):
    def test_the_id_comes_from_the_content_not_the_name(self):
        a = self.audio_file("a.mp3", b"mesmo som")
        b = self.audio_file("outro nome.flac", b"mesmo som")
        c = self.audio_file("c.mp3", b"som diferente")
        self.assertEqual(importer.file_id(a), importer.file_id(b))
        self.assertNotEqual(importer.file_id(a), importer.file_id(c))
        self.assertRegex(importer.file_id(a), importer.ID_RE.pattern)
        self.assertEqual(importer.file_id(a), "f-" + hashlib.sha256(b"mesmo som").hexdigest()[:12])

    def test_reads_the_file_in_chunks(self):
        big = self.audio_file("grande.wav", b"x" * (3 * importer.HASH_CHUNK + 17))
        self.assertEqual(importer.file_id(big), "f-" + hashlib.sha256(b"x" * (3 * importer.HASH_CHUNK + 17)).hexdigest()[:12])


class ProbeTests(TempDirCase):
    def test_duration_and_tags_in_any_case(self):
        info = importer.probe_audio(self.audio_file(), fake_run(probe_json("215.3", {"TITLE": "Tempo Perdido", "ARTIST": "Legião Urbana"})))
        self.assertEqual((info["duration"], info["title"], info["artist"], info["codec"]), (215.3, "Tempo Perdido", "Legião Urbana", "mp3"))

    def test_the_album_artist_when_the_artist_is_missing_and_empty_tags_become_none(self):
        info = importer.probe_audio(self.audio_file(), fake_run(probe_json(tags={"album_artist": "  Banda  ", "title": "   "})))
        self.assertEqual((info["artist"], info["title"]), ("Banda", None))

    def test_refuses_what_is_not_readable_audio(self):
        for run in (
            fake_run(probe_code=1),  # ffprobe failed
            fake_run("não é json"),
            fake_run(probe_json(streams=[{"codec_type": "video"}])),  # video only
            fake_run(probe_json(streams=[])),
            fake_run(probe_json(duration="0")),
            fake_run(probe_json(duration="N/A")),
        ):
            with self.assertRaises(JobError) as ctx:
                importer.probe_audio(self.audio_file(), run)
            self.assertEqual(ctx.exception.code, "bad_audio")

    def test_missing_ffmpeg_and_timeout(self):
        def missing(cmd, **kw):
            raise FileNotFoundError("ffprobe")

        def slow(cmd, **kw):
            raise subprocess.TimeoutExpired(cmd, 60)

        for run in (missing, slow):
            with self.assertRaises(JobError) as ctx:
                importer.probe_audio(self.audio_file(), run)
            self.assertEqual(ctx.exception.code, "audio")


class PrepareFileTests(TempDirCase):
    def prepare(self, path, run=None, **kw):
        work = self.dir / "work"
        work.mkdir(exist_ok=True)
        return importer.prepare_file(path, work, kw.pop("max_duration", 900.0), kw.pop("max_size", 10_000_000), run or fake_run(), **kw)

    def test_a_valid_file_becomes_a_song_with_the_decoded_audio(self):
        path = self.audio_file("Legião Urbana - Tempo Perdido.MP3", b"abc")
        song = self.prepare(path, fake_run(probe_json("240", {"artist": "Legião Urbana"})))
        self.assertEqual(song.video_id, importer.file_id(path))
        self.assertTrue(song.audio.exists())
        self.assertEqual(song.audio.name, "source.wav")
        self.assertEqual(song.info["video_title"], "Legião Urbana - Tempo Perdido")  # the file's name, without the extension
        self.assertEqual((song.info["artist"], song.info["track"], song.info["duration"], song.info["origin"]), ("Legião Urbana", None, 240.0, "file"))
        self.assertIsNone(song.info["subtitle_text"])
        self.assertTrue(path.exists())  # the original file is never moved or deleted

    def test_refusals_before_spending_time(self):
        for name, kwargs, code in (
            ("nao-existe.mp3", {}, "bad_audio"),
        ):
            with self.assertRaises(JobError) as ctx:
                self.prepare(self.dir / name, **kwargs)
            self.assertEqual(ctx.exception.code, code)
        for bad in ("texto.txt", "filme.mp4", "programa.exe", "semextensao", "musica.mp3.zip"):
            with self.assertRaises(JobError, msg=bad) as ctx:
                self.prepare(self.audio_file(bad))
            self.assertEqual(ctx.exception.code, "bad_audio")
        with self.assertRaises(JobError) as ctx:
            self.prepare(self.dir)  # a folder
        self.assertEqual(ctx.exception.code, "bad_audio")

    def test_every_listed_extension_is_accepted(self):
        for ext in importer.AUDIO_EXTENSIONS:
            self.assertTrue(self.prepare(self.audio_file(f"a{ext}", ext.encode())).audio.exists(), ext)

    def test_size_and_duration_have_limits(self):
        big = self.audio_file("grande.wav", b"x" * 2000)
        with self.assertRaises(JobError) as ctx:
            self.prepare(big, max_size=1000)
        self.assertEqual(ctx.exception.code, "too_big")
        with self.assertRaises(JobError) as ctx:
            self.prepare(self.audio_file("longa.mp3"), fake_run(probe_json("7200")), max_duration=900.0)
        self.assertEqual(ctx.exception.code, "too_long")
        self.assertIn("2 h", ctx.exception.message)
        self.prepare(self.audio_file("sem-limite.mp3"), fake_run(probe_json("7200")), max_duration=None)  # 0 turns the limit off

    def test_a_file_that_does_not_decode(self):
        with self.assertRaises(JobError) as ctx:
            self.prepare(self.audio_file("quebrado.mp3"), fake_run(decode_ok=False))
        self.assertEqual(ctx.exception.code, "bad_audio")

    def test_the_size_limit_comes_from_the_environment(self):
        self.assertEqual(importer.max_bytes({}), 200 * 1024 * 1024)
        self.assertEqual(importer.max_bytes({"IMPORT_MAX_MB": "10"}), 10 * 1024 * 1024)
        self.assertEqual(importer.max_bytes({"IMPORT_MAX_MB": "lixo"}), 200 * 1024 * 1024)


class HostAllowedTests(unittest.TestCase):
    def test_only_the_listed_sites_and_their_subdomains(self):
        for url in (
            "https://soundcloud.com/artista/musica", "https://m.soundcloud.com/x", "http://soundcloud.com/a/b",
            "https://artista.bandcamp.com/track/musica", "https://bandcamp.com/x", "https://archive.org/details/item",
            "https://www.archive.org/details/item", "https://SoundCloud.COM/Artista/Musica", "https://soundcloud.com:443/a/b", "  https://archive.org/details/x  ",
        ):
            self.assertIsNotNone(importer.host_allowed(url), url)
        self.assertEqual(importer.host_allowed("https://x.bandcamp.com/track/y"), "bandcamp.com")

    def test_names_that_only_end_the_same_and_other_forms_are_refused(self):
        for url in (
            "https://notsoundcloud.com/x", "https://evilbandcamp.com/x", "https://soundcloud.com.evil.example/x", "https://evil.example/soundcloud.com",
            "https://evil.example/?u=https://soundcloud.com/x", "https://soundcloud.com@evil.example/x", "https://user:pw@soundcloud.com/x",
            "https://soundcloud.com:8080/x", "ftp://archive.org/x", "javascript:alert(1)", "file:///C:/musica.mp3",
            "soundcloud.com/artista/musica", "https://youtube.com/watch?v=abcdefghijk", "https://www.youtube.com/", "", "   ", "https://",
            "https://archive.org.evil.example/x", "https://sound-cloud.com/x", "https://[::1]/x",
        ):
            self.assertIsNone(importer.host_allowed(url), url)

    def test_only_the_single_track_extractors(self):
        def allowed(name):
            return any(re.search(pattern, name) for pattern in importer.OPEN_EXTRACTORS)

        for name in ("soundcloud", "Bandcamp", "archive.org"):
            self.assertTrue(allowed(name), name)
        for name in ("soundcloud:playlist", "soundcloud:set", "soundcloud:search", "soundcloud:user", "Bandcamp:album", "Bandcamp:user", "Bandcamp:weekly",
                     "youtube", "youtube:tab", "generic", "youtube:search", "vimeo", "mixch:archive", "SoundcloudEmbed"):
            self.assertFalse(allowed(name), name)

    @unittest.skipIf(yt_dlp is None, "precisa do yt-dlp instalado")
    def test_against_the_real_yt_dlp_only_these_three_extractors_match(self):
        # yt-dlp's filter matches the extractor's NAME: this test checks it against yt-dlp's real list (and catches a future rename)
        from yt_dlp.extractor import gen_extractor_classes

        matched = sorted({ie.IE_NAME for ie in gen_extractor_classes() if any(re.search(p, ie.IE_NAME) for p in importer.OPEN_EXTRACTORS)})
        self.assertEqual(sorted(m.lower() for m in matched), ["archive.org", "bandcamp", "soundcloud"])


class FakeYoutubeDL:
    """A fake yt-dlp: keeps the options and produces source.wav as the postprocessor would."""

    instances = []

    def __init__(self, opts, info=None, fail=None):
        self.opts = opts
        self.info = info if info is not None else {"title": "Faixa Livre", "artist": "Banda Livre", "duration": 180, "id": "x"}
        self.fail = fail
        FakeYoutubeDL.instances.append(self)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def extract_info(self, url, download=False):
        if self.fail:
            raise self.fail
        return dict(self.info)

    def process_ie_result(self, info, download=True):
        Path(self.opts["outtmpl"].replace("%(ext)s", "wav")).write_bytes(b"RIFFbaixado")
        return info


class PrepareUrlTests(TempDirCase):
    def prepare(self, url="https://artista.bandcamp.com/track/faixa", info=None, fail=None, max_duration=900.0):
        FakeYoutubeDL.instances.clear()
        work = self.dir / "work"
        work.mkdir(exist_ok=True)
        return importer.prepare_url(url, work, max_duration, lambda opts: FakeYoutubeDL(opts, info, fail))

    def test_downloads_without_cookies_and_only_with_the_single_track_extractors(self):
        song = self.prepare()
        opts = FakeYoutubeDL.instances[0].opts
        self.assertEqual(opts["allowed_extractors"], list(importer.OPEN_EXTRACTORS))
        self.assertTrue(opts["noplaylist"])
        for forbidden in ("cookiefile", "cookiesfrombrowser", "cookies"):
            self.assertNotIn(forbidden, opts)  # these sites need nobody's account
        self.assertEqual(opts["format"], "bestaudio/best")
        self.assertEqual(song.video_id, importer.file_id(song.audio))  # the id comes from the downloaded CONTENT
        self.assertEqual((song.info["video_title"], song.info["artist"], song.info["track"], song.info["origin"]),
                         ("Faixa Livre", "Banda Livre", "Faixa Livre", "url:bandcamp.com"))

    def test_the_artist_falls_back_to_the_creator_and_then_to_the_uploader(self):
        self.assertEqual(self.prepare(info={"title": "T", "creator": "Criador", "uploader": "Canal", "duration": 10}).info["artist"], "Criador")
        self.assertEqual(self.prepare(info={"title": "T", "uploader": "Canal", "duration": 10}).info["artist"], "Canal")
        self.assertEqual(self.prepare(info={"title": "T", "track": "Faixa", "artist": "A", "duration": 10}).info["track"], "Faixa")

    def test_an_unlisted_link_does_not_even_call_yt_dlp(self):
        FakeYoutubeDL.instances.clear()
        for url in ("https://www.youtube.com/watch?v=abcdefghijk", "https://notsoundcloud.com/x", "https://example.com/musica.mp3", ""):
            with self.assertRaises(JobError) as ctx:
                importer.prepare_url(url, self.dir, 900.0, lambda opts: self.fail("não devia chamar o yt-dlp"))
            self.assertEqual(ctx.exception.code, "not_open_source", url)
        self.assertEqual(FakeYoutubeDL.instances, [])

    def test_album_playlist_live_and_too_long(self):
        for info, code in (
            ({"_type": "playlist", "entries": [{}]}, "not_open_source"),
            ({"entries": [{"id": "a"}], "title": "Álbum"}, "not_open_source"),
            ({"title": "Show", "is_live": True, "duration": 10}, "live"),
            ({"title": "Coletânea", "duration": 5400}, "too_long"),
        ):
            with self.assertRaises(JobError, msg=str(info)) as ctx:
                self.prepare(info=info)
            self.assertEqual(ctx.exception.code, code)

    def test_yt_dlp_errors_become_clear_messages(self):
        for text, code in (
            ("ERROR: No suitable extractor found for URL https://x", "not_open_source"),
            ("ERROR: Unsupported URL: https://x", "not_open_source"),
            ("ERROR: [soundcloud] x: Sign in to listen", "not_downloadable"),
            ("ERROR: This track is private", "not_downloadable"),
            ("HTTP Error 403: Forbidden", "not_downloadable"),
            ("ERROR: unable to download video data: HTTP Error 404", "not_downloadable"),
            ("urlopen error [Errno -3] Temporary failure in name resolution", "download_failed"),
        ):
            with self.assertRaises(JobError, msg=text) as ctx:
                self.prepare(fail=RuntimeError(text))
            self.assertEqual(ctx.exception.code, code, text)

    def test_a_download_that_ends_without_the_file(self):
        class NoFile(FakeYoutubeDL):
            def process_ie_result(self, info, download=True):
                return info

        work = self.dir / "w2"
        work.mkdir()
        with self.assertRaises(JobError) as ctx:
            importer.prepare_url("https://archive.org/details/x", work, 900.0, lambda opts: NoFile(opts))
        self.assertEqual(ctx.exception.code, "download_failed")


class ResolveNamesTests(unittest.TestCase):
    def test_priority_given_then_tag_then_guess_from_the_name(self):
        info = {"video_title": "Legião Urbana - Tempo Perdido (ao vivo)", "artist": "Etiqueta A", "track": "Etiqueta T"}
        self.assertEqual(importer.resolve_names(info, "Informado", "Informada"), ("Informado", "Informada"))
        self.assertEqual(importer.resolve_names(info, None, None), ("Etiqueta A", "Etiqueta T"))
        self.assertEqual(importer.resolve_names({"video_title": "Legião Urbana - Tempo Perdido (ao vivo)"}, None, None), ("Legião Urbana", "Tempo Perdido"))
        self.assertEqual(importer.resolve_names({"video_title": "faixa01"}, None, None), (None, "faixa01"))  # no artist: the caller requires one
        self.assertEqual(importer.resolve_names({}, "  ", None), (None, None))


class ImportSongTests(TempDirCase):
    """The whole path, with the separation, the melody and the key faked (Demucs is tested apart, in Docker)."""

    def setUp(self):
        super().setUp()
        self.storage = LocalStorage(self.dir / "storage")
        self.separated = 0

        def separate(audio, work, device, timeout=None):
            self.separated += 1
            inst, voc = work / "instrumental.mp3", work / "vocals.mp3"
            inst.write_bytes(b"instrumental")
            voc.write_bytes(b"voz")
            return inst, voc

        patches = [
            mock.patch.object(pipeline, "separate", side_effect=separate),
            mock.patch.object(pipeline, "extract_melody", return_value={"hop": 0.05, "midi": [60]}),
            mock.patch.object(pipeline, "detect_key", return_value={"tonic": 0, "mode": "major"}),
            mock.patch.object(pipeline, "download", side_effect=AssertionError("importar não baixa do YouTube")),
        ]
        for p in patches:
            p.start()
            self.addCleanup(p.stop)

    def run_import(self, **kw):
        path = kw.pop("file", None) or self.audio_file("Legião Urbana - Tempo Perdido.mp3")
        with mock.patch.object(importer, "prepare_file", side_effect=lambda p, work, max_duration, *a, **k: self._prepared(p, work)):
            return importer.import_song(self.storage, file=path, limits=LIMITS, lyrics_source=kw.pop("lyrics_source", "none"), **kw)

    def _prepared(self, path, work):
        wav = work / "source.wav"
        wav.write_bytes(b"RIFF")
        return ImportedSong(importer.file_id(path), wav, {"video_title": path.stem, "track": None, "artist": None, "duration": 215.0,
                                                           "subtitle_text": None, "subtitle_error": None, "origin": "file"})

    def test_imports_and_leaves_it_ready_in_the_library(self):
        meta = self.run_import()
        vid = meta["video_id"]
        self.assertRegex(vid, r"^f-[0-9a-f]{12}$")
        for name in ("instrumental.mp3", "vocals.mp3", "lyrics.json", "melody.json", "meta.json", "source.json"):
            self.assertTrue(self.storage.exists(f"cache/{vid}/{name}"), name)
        self.assertEqual((meta["artist"], meta["title"], meta["origin"], meta["lyrics_source"]), ("Legião Urbana", "Tempo Perdido", "file", "none"))
        self.assertEqual(meta["duration"], 215.0)
        self.assertEqual(meta["key"], {"tonic": 0, "mode": "major"})
        self.assertEqual(json.loads(self.storage.read(f"cache/{vid}/lyrics.json")), [])
        self.assertTrue(pipeline.is_ready(self.storage, vid))

    def test_the_given_artist_and_title_beat_the_file_name(self):
        meta = self.run_import(artist="Outro Artista", title="Outra Música")
        self.assertEqual((meta["artist"], meta["title"]), ("Outro Artista", "Outra Música"))

    def test_without_artist_and_title_asks_for_both(self):
        with self.assertRaises(JobError) as ctx:
            self.run_import(file=self.audio_file("faixa01.mp3", b"outro conteudo"))
        self.assertEqual(ctx.exception.code, "artist_title_required")
        self.assertIn("--artist", ctx.exception.message)
        self.assertEqual(self.separated, 0)  # does not even start separating

    def test_importing_the_same_content_again_returns_the_existing_song(self):
        first = self.run_import()
        again = self.run_import(file=self.audio_file("copia com outro nome.mp3", self.dir.joinpath("Legião Urbana - Tempo Perdido.mp3").read_bytes()))
        self.assertEqual(again["video_id"], first["video_id"])
        self.assertEqual(self.separated, 1)  # the second one did not separate again

    def test_force_redoes_it(self):
        self.run_import()
        self.run_import(force=True)
        self.assertEqual(self.separated, 2)

    def test_explicit_lyrics_redo_only_the_lyrics(self):
        first = self.run_import()
        meta = self.run_import(lyrics_source="file", lyrics_text="[00:01.00]Olá\n[00:03.00]Mundo")
        self.assertEqual(meta["video_id"], first["video_id"])
        self.assertEqual(meta["lyrics_source"], "file")
        self.assertEqual(self.separated, 1)  # the instrumental stays in the cache
        self.assertEqual(len(json.loads(self.storage.read(f"cache/{first['video_id']}/lyrics.json"))), 2)

    def test_needs_lyrics_is_not_a_failure(self):
        with self.assertRaises(NeedsLyrics):
            self.run_import(lyrics_source="video")  # a file has no video subtitles

    def test_without_the_isolated_vocals_does_not_try_to_download_again(self):
        first = self.run_import()
        self.storage.delete(f"cache/{first['video_id']}/vocals.mp3")
        self.storage.delete(f"cache/{first['video_id']}/melody.json")
        with self.assertRaises(JobError) as ctx:
            self.run_import(lyrics_source="align", lyrics_text="Olá mundo")  # the AI would need the vocals
        self.assertEqual(ctx.exception.code, "no_vocals")

    def test_a_file_or_a_link_but_not_both_or_neither(self):
        with self.assertRaises(ValueError):
            importer.import_song(self.storage, limits=LIMITS)
        with self.assertRaises(ValueError):
            importer.import_song(self.storage, file="a.mp3", url="https://archive.org/details/x", limits=LIMITS)

    def test_an_open_source_link_follows_the_same_path(self):
        def fake_prepare_url(url, work, max_duration, *a, **k):
            wav = work / "source.wav"
            wav.write_bytes(b"RIFFbaixado")
            return ImportedSong(importer.file_id(wav), wav, {"video_title": "Faixa Livre", "track": "Faixa Livre", "artist": "Banda Livre",
                                                              "duration": 180, "subtitle_text": None, "subtitle_error": None, "origin": "url:archive.org"})

        with mock.patch.object(importer, "prepare_url", side_effect=fake_prepare_url):
            meta = importer.import_song(self.storage, url="https://archive.org/details/x", limits=LIMITS, lyrics_source="none")
        self.assertEqual((meta["artist"], meta["title"], meta["origin"]), ("Banda Livre", "Faixa Livre", "url:archive.org"))
        self.assertTrue(pipeline.is_ready(self.storage, meta["video_id"]))

    def test_reported_stages(self):
        stages = []
        self.run_import(on_stage=stages.append)
        self.assertEqual(stages[0], "importing")
        self.assertIn("separating", stages)


class YouTubePathStillWorksTests(TempDirCase):
    """Regression: the change in process() that accepts imported songs must not change the YouTube path."""

    def test_downloads_separates_and_writes_as_before(self):
        storage = LocalStorage(self.dir / "storage")

        def download(url, work, langs, cookies, max_duration):
            (work / "source.wav").write_bytes(b"RIFF")
            return {"video_title": "Legião Urbana - Tempo Perdido", "track": None, "artist": None, "duration": 300,
                    "subtitle_text": None, "subtitle_error": None, "audio": work / "source.wav"}

        def separate(audio, work, device, timeout=None):
            inst, voc = work / "instrumental.mp3", work / "vocals.mp3"
            inst.write_bytes(b"i")
            voc.write_bytes(b"v")
            return inst, voc

        with mock.patch.object(pipeline, "download", side_effect=download) as dl, mock.patch.object(pipeline, "separate", side_effect=separate), \
                mock.patch.object(pipeline, "extract_melody", return_value={"hop": 0.05, "midi": [60]}), mock.patch.object(pipeline, "detect_key", return_value=None):
            meta = pipeline.process("https://www.youtube.com/watch?v=abcdefghijk", storage, lyrics_source="none", limits=LIMITS)
        self.assertEqual(dl.call_count, 1)
        self.assertEqual((meta["video_id"], meta["artist"], meta["title"]), ("abcdefghijk", "Legião Urbana", "Tempo Perdido"))
        self.assertNotIn("origin", meta)  # only imported songs have an origin
        for name in ("instrumental.mp3", "vocals.mp3", "lyrics.json", "meta.json", "source.json", "melody.json"):
            self.assertTrue(storage.exists(f"cache/abcdefghijk/{name}"), name)
        with self.assertRaises(ValueError):
            pipeline.process("https://example.com/x", storage, limits=LIMITS)  # still requires a YouTube link


class CliImportTests(TempDirCase):
    def run_cli(self, argv, env=None, meta=None, error=None, backend_cls=None):
        out = io.StringIO()
        patches = [mock.patch.dict("os.environ", env or {}, clear=False)]
        if error is not None or meta is not None:
            patches.append(mock.patch.object(importer, "import_song", side_effect=error, return_value=meta))
        if backend_cls is not None:
            patches.append(mock.patch("singalong_worker.backend.HttpBackend", backend_cls))
        for p in patches:
            p.start()
        try:
            with redirect_stdout(out):
                code = cli.main(argv)
        finally:
            for p in reversed(patches):
                p.stop()
        return code, out.getvalue()

    META = {"video_id": "f-0123456789ab", "artist": "A", "title": "B", "lyrics_source": "none"}

    def test_success_without_a_configured_agent(self):
        with mock.patch.dict("os.environ", {}, clear=False):
            for name in ("AGENT_URL", "AGENT_TOKEN"):
                import os
                os.environ.pop(name, None)
            code, out = self.run_cli(["--import", str(self.audio_file()), "--storage-root", str(self.dir / "s")], meta=self.META)
        self.assertEqual(code, 0)
        self.assertIn("Pronto: A - B", out)
        self.assertIn("só na biblioteca local", out)

    def test_with_the_agent_configured_publishes_to_the_catalog(self):
        published = []

        class FakeBackend:
            def __init__(self, url, token, *a):
                self._shared = SimpleNamespace(unpublished=set())

            def attach_storage(self, storage):
                pass

            def publish_song(self, video_id, force=False):
                published.append((video_id, force))

        code, out = self.run_cli(["--import-url", "https://archive.org/details/x", "--storage-root", str(self.dir / "s")],
                                 env={"AGENT_URL": "https://sing.example.org", "AGENT_TOKEN": "sga_x"}, meta=self.META, backend_cls=FakeBackend)
        self.assertEqual((code, published), (0, [("f-0123456789ab", True)]))
        self.assertIn("Publicada no catálogo", out)

    def test_exit_codes_and_messages(self):
        cases = (
            (ValueError("Informe um arquivo OU um link"), 2, "erro:"),
            (NeedsLyrics("Este vídeo não tem legenda"), 3, "needs_lyrics:"),
            (JobError("bad_audio", "Não consegui ler este arquivo", "never"), 4, "erro (bad_audio)"),
            (KeyError("bug"), 4, "erro (unknown)"),
        )
        for error, expected, text in cases:
            code, out = self.run_cli(["--import", str(self.audio_file()), "--storage-root", str(self.dir / "s")], error=error)
            self.assertEqual(code, expected, str(error))
            self.assertIn(text, out)

    def test_does_not_accept_a_file_and_a_link_together(self):
        code, out = self.run_cli(["--import", str(self.audio_file()), "--import-url", "https://archive.org/details/x"])
        self.assertEqual(code, 2)
        self.assertIn("OU", out)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
