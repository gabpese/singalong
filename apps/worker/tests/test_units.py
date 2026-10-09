import tempfile
import unittest
from pathlib import Path

from singalong_worker.ids import extract_video_id
from singalong_worker.lyrics import apply_text, parse_cues, parse_lrc, parse_lyrics_file
from singalong_worker.storage import LocalStorage

VID = "dQw4w9WgXcQ"


class IdTests(unittest.TestCase):
    def test_formats(self):
        for url in [
            f"https://www.youtube.com/watch?v={VID}&t=10",
            f"https://youtu.be/{VID}?si=abc",
            f"https://m.youtube.com/watch?v={VID}",
            f"https://music.youtube.com/watch?v={VID}",
            f"https://www.youtube.com/shorts/{VID}",
            f"https://www.youtube.com/embed/{VID}",
            VID,
        ]:
            self.assertEqual(extract_video_id(url), VID, url)

    def test_invalid(self):
        for url in ["", "https://example.com/watch?v=" + VID, "https://youtu.be/curto", "https://www.youtube.com/watch"]:
            self.assertIsNone(extract_video_id(url), url)


class LyricsTests(unittest.TestCase):
    def test_srt(self):
        srt = "1\n00:00:01,000 --> 00:00:03,500\nOlá <i>mundo</i>\n\n2\n00:00:04,000 --> 00:00:05,000\nLinha 2\n"
        self.assertEqual(
            parse_cues(srt),
            [{"start": 1.0, "end": 3.5, "text": "Olá mundo"}, {"start": 4.0, "end": 5.0, "text": "Linha 2"}],
        )

    def test_vtt_rolling_dedupe(self):
        vtt = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nA\n\n00:00:02.000 --> 00:00:03.000\nA\n\n00:00:03.000 --> 00:00:04.000\nB\n"
        cues = parse_cues(vtt)
        self.assertEqual([c["text"] for c in cues], ["A", "B"])
        self.assertEqual(cues[0]["end"], 3.0)

    def test_lrc(self):
        lrc = "[ar:x]\n[00:01.50]Primeira\n[00:04.00]Segunda\n[00:06.25]\n[00:08.00]Terceira"
        cues = parse_lrc(lrc)
        self.assertEqual(cues[0], {"start": 1.5, "end": 4.0, "text": "Primeira"})
        self.assertEqual(cues[1]["end"], 6.25)
        self.assertEqual(cues[2]["text"], "Terceira")

    def test_autodetect_and_reject(self):
        self.assertEqual(len(parse_lyrics_file("[00:01.00]a")), 1)
        with self.assertRaises(ValueError):
            parse_lyrics_file("só texto sem tempo")


class ApplyTextTests(unittest.TestCase):
    TIMED = [{"start": 1.0, "end": 2.0, "text": "coat"}, {"start": 2.0, "end": 3.0, "text": "b"}]

    def test_replaces_text_keeps_timing(self):
        out = apply_text("cold\n\n  segunda  \n", self.TIMED)
        self.assertEqual(out, [{"start": 1.0, "end": 2.0, "text": "cold"}, {"start": 2.0, "end": 3.0, "text": "segunda"}])

    def test_line_count_mismatch(self):
        with self.assertRaises(ValueError):
            apply_text("só uma", self.TIMED)


class StorageTests(unittest.TestCase):
    def test_contract(self):
        with tempfile.TemporaryDirectory() as d, tempfile.TemporaryDirectory() as src:
            s = LocalStorage(d)
            f = Path(src) / "a.txt"
            f.write_text("oi")
            self.assertFalse(s.exists("cache/x/a.txt"))
            s.put("cache/x/a.txt", f)
            self.assertTrue(s.exists("cache/x/a.txt"))
            self.assertEqual(s.read("cache/x/a.txt"), b"oi")
            self.assertEqual(s.list("cache/x"), ["cache/x/a.txt"])
            self.assertTrue(s.get_url("cache/x/a.txt").endswith("/media/cache/x/a.txt"))
            s.delete("cache/x")
            self.assertEqual(s.list("cache"), [])

    def test_path_traversal(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(ValueError):
                LocalStorage(d).exists("../fora")


if __name__ == "__main__":
    unittest.main()
