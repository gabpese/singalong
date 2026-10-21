import json
import tempfile
import unittest
from pathlib import Path

from singalong_worker.align import attach_words, clean_lines, group_words
from singalong_worker.backing import backing_share, find_missing, is_usable, process as backing_process
from singalong_worker.meta_store import update_meta
from singalong_worker.export import ass_time, build_ass, ffmpeg_command, karaoke_text, output_key, pitch_filter
from singalong_worker.ids import extract_video_id
from singalong_worker.melody import lyric_spans, melody_from_f0
from singalong_worker.key import MAJOR_PROFILE, MINOR_PROFILE, NOTES, best_key
from singalong_worker.lyrics import apply_text, parse_cues, parse_lrc, parse_lyrics_file, pick_candidate
from singalong_worker.search import parse_entries
from singalong_worker.pipeline import NeedsAlignment, NeedsLyrics, guess_artist_title, manual_subtitle_langs, resolve_lyrics
from singalong_worker.storage import LocalStorage
from singalong_worker.titles import backfill as titles_backfill

VID = "dQw4w9WgXcQ"


class ExportTests(unittest.TestCase):
    CUE = {"start": 10.0, "end": 12.0, "text": "Hello brave world", "words": [[10.0, 10.5], [10.6, 11.2], [11.2, 12.0]]}

    def test_ass_time(self):
        self.assertEqual(ass_time(0), "0:00:00.00")
        self.assertEqual(ass_time(62.22), "0:01:02.22")
        self.assertEqual(ass_time(3725.5), "1:02:05.50")

    def test_karaoke_uses_real_word_times(self):
        text = karaoke_text(self.CUE, 10.0)
        # each word fills until the next one starts: 60 cs (0.5 s + the pause), 60 cs and 80 cs
        self.assertEqual(text, "{\\kf60}Hello {\\kf60}brave {\\kf80}world")

    def test_karaoke_lead_in_and_estimate(self):
        self.assertTrue(karaoke_text(self.CUE, 8.5).startswith("{\\k150}{\\kf60}Hello"))  # shows up 1.5 s before
        estimated = karaoke_text({"start": 0.0, "end": 2.0, "text": "aa bbbb"}, 0.0)  # no timings: by the words' length
        self.assertEqual(estimated, "{\\kf67}aa {\\kf133}bbbb")

    def test_build_ass(self):
        cues = [
            self.CUE,
            {"start": 12.5, "end": 14.0, "text": "Second {line}"},
        ]
        ass = build_ass(cues, "Título", "Artista", 200)
        self.assertIn("Style: Current", ass)
        self.assertIn("Dialogue: 0,0:00:00.00,0:00:06.00,Title,,0,0,0,,Título\\N{\\fs38\\1c&H00C8C8D2&}Artista", ass)  # a 6 s card with the artist
        self.assertIn("Dialogue: 1,0:00:08.50,0:00:12.00,Current", ass)  # line 2 only shows up when the 1st ends
        self.assertIn("Second (line)", ass)  # braces become parentheses: they are not ASS tags
        self.assertIn(",Next,,0,0,0,,{\\pos(640,490)}Second (line)", ass)  # the next line shows up in gray below

    def test_build_ass_without_lyrics_keeps_the_title(self):
        ass = build_ass([], "Título", None, 180)
        self.assertIn("0:03:00.00,Title", ass)

    def test_output_key_and_pitch_filter(self):
        self.assertEqual(output_key("abcdefghijk", 0), "cache/abcdefghijk/karaoke.mp4")
        self.assertEqual(output_key("abcdefghijk", 2), "cache/abcdefghijk/karaoke_p+2.mp4")
        self.assertEqual(output_key("abcdefghijk", -3), "cache/abcdefghijk/karaoke_p-3.mp4")
        self.assertEqual(pitch_filter(0), [])
        self.assertEqual(pitch_filter(12, rubberband=True), ["-af", "rubberband=pitch=2.000000"])

    def test_pitch_filter_without_rubberband_uses_asetrate_and_atempo(self):
        # macOS's ffmpeg has no rubberband: the pitch rises through the sample rate, and atempo restores the duration
        self.assertEqual(pitch_filter(0, rubberband=False), [])
        self.assertEqual(pitch_filter(12, rubberband=False), ["-af", "aresample=44100,asetrate=88200,aresample=44100,atempo=0.500000"])
        down = pitch_filter(-12, rubberband=False)[1]
        self.assertIn("asetrate=22050", down)
        self.assertIn("atempo=2.000000", down)  # within atempo's limit (0.5 to 100)
        self.assertTrue(all(0.5 <= 2 ** (-p / 12) <= 2 for p in range(-12, 13)))

    def test_has_rubberband_reads_the_ffmpeg_filter_list_and_assumes_yes_when_it_cannot_run(self):
        from singalong_worker import export
        from unittest import mock

        def ran(stdout):
            return mock.Mock(stdout=stdout)

        for stdout, expected in ((" ... rubberband  A->A  Pitch-shift\n", True), (" ... subtitles  V->V  Render\n", False)):
            export._rubberband = None
            with mock.patch.object(export.subprocess, "run", return_value=ran(stdout)):
                self.assertIs(export.has_rubberband(), expected)
        export._rubberband = None
        with mock.patch.object(export.subprocess, "run", side_effect=FileNotFoundError):
            self.assertIs(export.has_rubberband(), True)
        export._rubberband = None

    def test_ffmpeg_command_escapes_the_subtitle_path(self):
        cmd = ffmpeg_command(Path("C:\\tmp\\lyrics.ass"), Path("a.mp3"), Path("o.mp4"), 0, "T", "A")
        self.assertIn("ass=C\\:/tmp/lyrics.ass", cmd)
        self.assertEqual(cmd[-1], "o.mp4")
        self.assertIn("artist=A", cmd)


class MelodyTests(unittest.TestCase):
    def test_notes_and_silence(self):
        out = melody_from_f0([440.0, 440.0, None, float("nan"), 261.63, 261.63, 0])
        self.assertEqual(out["midi"], [69, 69, -1, -1, 60, 60, -1])
        self.assertEqual(out["hop"], 0.05)

    def test_ignores_leak_and_pauses(self):
        f0 = [440.0] * 100  # 5 s of "voice" the whole time, the way the detector sees the leakage
        energy = [1.0] * 40 + [0.01] * 20 + [1.0] * 40  # 2 s to 3 s: leakage only (very low)
        out = melody_from_f0(f0, energy, [(0.0, 1.0), (3.0, 5.0)])  # the lyrics only sing from 0 to 1 s and from 3 s on
        voiced = [i for i, m in enumerate(out["midi"]) if m >= 0]
        self.assertEqual(voiced[0], 0)
        self.assertTrue(all(i <= 20 or i >= 60 for i in voiced))  # nothing between 1 s and 3 s
        self.assertEqual(out["midi"][25], -1)
        self.assertEqual(out["midi"][70], 69)

    def test_lyric_spans(self):
        self.assertIsNone(lyric_spans([]))
        self.assertEqual(lyric_spans([{"start": 10, "end": 12}]), [(9.75, 12.25)])

    def test_drops_isolated_blips(self):
        out = melody_from_f0([None, 440.0, None, 440.0, 440.0, 440.0])
        self.assertEqual(out["midi"], [-1, -1, -1, 69, 69, 69])


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


class PipelineTests(unittest.TestCase):
    SUBS = "WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nUm\n\n00:00:03.000 --> 00:00:04.000\nDois\n"

    def info(self, **kw):
        return {"subtitle_text": None, "artist": None, "title": None, "duration": 10, **kw}

    def test_guess_artist_title(self):
        self.assertEqual(guess_artist_title("Faouzia - Unethical (MAPHRA Vocal Cover)"), ("Faouzia", "Unethical"))
        self.assertEqual(guess_artist_title("Sem hifen aqui"), (None, None))

    def test_manual_subtitle_langs(self):
        available = {"en-US": [], "pt-BR": [], "live_chat": [], "fr": []}
        self.assertEqual(manual_subtitle_langs(available, ["pt", "en"]), ["pt-BR", "en-US"])
        self.assertEqual(manual_subtitle_langs({}, ["pt", "en"]), [])  # no manual subtitles: does not even try to download
        self.assertEqual(manual_subtitle_langs({"live_chat": []}, ["pt", "en"]), [])

    def test_auto_uses_the_video_subtitles(self):
        cues, source = resolve_lyrics("auto", self.info(subtitle_text=self.SUBS), None)
        self.assertEqual((source, [c["text"] for c in cues]), ("video", ["Um", "Dois"]))

    def test_auto_without_subtitles_asks_for_lyrics(self):
        with self.assertRaises(NeedsLyrics):
            resolve_lyrics("auto", self.info(), None)

    def test_subtitles_with_a_download_error_have_their_own_message(self):
        with self.assertRaisesRegex(NeedsLyrics, "bloqueou o download"):
            resolve_lyrics("auto", self.info(subtitle_error="HTTP Error 429"), None)

    def test_no_lyrics_is_always_possible(self):
        self.assertEqual(resolve_lyrics("none", self.info(), None), ([], "none"))

    def test_pick_candidate_respects_the_duration(self):
        cands = [{"duration": 194.0, "name": "a", "syncedLyrics": "x"}, {"duration": 180.0, "name": "b", "syncedLyrics": "x"}]
        self.assertEqual(pick_candidate(cands, 195, loose=False)[0]["name"], "a")  # within ±5 s
        chosen, closest = pick_candidate(cands, 265, loose=False)  # a much longer cover
        self.assertIsNone(chosen)
        self.assertEqual(closest["name"], "a")  # it explains the refusal
        self.assertEqual(pick_candidate(cands, 265, loose=True)[0]["name"], "a")  # accepted anyway
        self.assertEqual(pick_candidate([], 265), (None, None))
        self.assertIsNotNone(pick_candidate(cands, None)[0])  # no known duration: there is no way to refuse

    def test_video_without_subtitles(self):
        with self.assertRaises(NeedsLyrics):
            resolve_lyrics("video", self.info(), None)

    def test_text_uses_the_video_subtitle_timings(self):
        cues, source = resolve_lyrics("text", self.info(subtitle_text=self.SUBS), "Eu\nTu")
        self.assertEqual(source, "text+video")
        self.assertEqual([(c["start"], c["text"]) for c in cues], [(1.0, "Eu"), (3.0, "Tu")])

    def test_the_lyrics_service_being_down_is_not_a_failure(self):
        from unittest import mock

        from singalong_worker import lyrics as lyr

        info = self.info(artist="A", title="B")
        with mock.patch.object(lyr, "search_lrclib", side_effect=lyr.LyricsServiceError("503")):
            with self.assertRaisesRegex(NeedsLyrics, "não respondeu"):
                resolve_lyrics("lrclib", info, None)

    def test_fetch_json_retries_on_5xx_but_not_on_4xx(self):
        import io
        import urllib.error
        from unittest import mock

        from singalong_worker import lyrics as lyr

        def http_error(code):
            return urllib.error.HTTPError("u", code, "x", {}, io.BytesIO(b""))

        ok = mock.MagicMock()
        ok.__enter__.return_value = io.BytesIO(b'[{"a": 1}]')
        with mock.patch("urllib.request.urlopen", side_effect=[http_error(503), http_error(502), ok]) as m:
            self.assertEqual(lyr._fetch_json("req", pause=0), [{"a": 1}])
            self.assertEqual(m.call_count, 3)
        with mock.patch("urllib.request.urlopen", side_effect=[http_error(404)]) as m:
            with self.assertRaises(lyr.LyricsServiceError):
                lyr._fetch_json("req", pause=0)
            self.assertEqual(m.call_count, 1)  # 4xx: repeating is useless

    def test_text_without_a_timing_reference_goes_to_the_ai(self):
        # pasted lyrics, no subtitles in the video and no artist/title to search online: the AI syncs them
        with self.assertRaises(NeedsAlignment) as ctx:
            resolve_lyrics("text", self.info(), "uma linha\noutra linha")
        self.assertEqual((ctx.exception.text, ctx.exception.origin), ("uma linha\noutra linha", "text"))

    def test_text_with_a_different_line_count_goes_to_the_ai(self):
        with self.assertRaises(NeedsAlignment):
            resolve_lyrics("text", self.info(subtitle_text=self.SUBS), "só uma")

    def test_align_always_asks_for_alignment_and_requires_text(self):
        with self.assertRaises(NeedsAlignment) as ctx:
            resolve_lyrics("align", self.info(), "a\nb")
        self.assertEqual(ctx.exception.origin, "align")
        with self.assertRaises(ValueError):
            resolve_lyrics("align", self.info(), "  ")

    def test_online_search_uses_the_timings_when_the_duration_matches(self):
        from unittest import mock

        from singalong_worker import lyrics as lyr

        cands = [{"duration": 205, "syncedLyrics": "[00:01.00]um\n[00:03.00]dois", "plainLyrics": "um\ndois"}]
        with mock.patch.object(lyr, "search_lrclib", return_value=cands):
            cues, source = resolve_lyrics("lrclib", self.info(artist="A", title="B", duration=206), None)
        self.assertEqual((source, [c["text"] for c in cues]), ("lrclib", ["um", "dois"]))

    def test_online_search_with_a_different_duration_hands_the_text_to_the_ai(self):
        from unittest import mock

        from singalong_worker import lyrics as lyr

        cands = [{"duration": 194, "syncedLyrics": "[00:01.00]um\n[00:03.00]dois", "plainLyrics": "um\ndois"}]
        with mock.patch.object(lyr, "search_lrclib", return_value=cands):
            with self.assertRaises(NeedsAlignment) as ctx:  # a 265 s cover: the 194 s timings do not fit
                resolve_lyrics("lrclib", self.info(artist="A", title="B", duration=265), None)
        self.assertEqual((ctx.exception.text, ctx.exception.origin), ("um\ndois", "lrclib"))
        # with 'loose' it uses their timings anyway, without AI
        with mock.patch.object(lyr, "search_lrclib", return_value=cands):
            cues, source = resolve_lyrics("lrclib", self.info(artist="A", title="B", duration=265), None, loose=True)
        self.assertEqual(source, "lrclib")

    def test_online_search_with_text_only_goes_to_the_ai(self):
        from unittest import mock

        from singalong_worker import lyrics as lyr

        cands = [{"duration": 200, "syncedLyrics": None, "plainLyrics": "linha a\nlinha b"}]
        with mock.patch.object(lyr, "search_lrclib", return_value=cands):
            with self.assertRaises(NeedsAlignment) as ctx:
                resolve_lyrics("lrclib", self.info(artist="A", title="B", duration=200), None)
        self.assertEqual(ctx.exception.text, "linha a\nlinha b")

    def test_online_search_without_results_asks_for_another_option(self):
        from unittest import mock

        from singalong_worker import lyrics as lyr

        with mock.patch.object(lyr, "search_lrclib", return_value=[]):
            with self.assertRaisesRegex(NeedsLyrics, "Não achei essa letra"):
                resolve_lyrics("lrclib", self.info(artist="A", title="B"), None)

    def test_candidate_text(self):
        from singalong_worker.lyrics import best_text_candidate, candidate_text

        self.assertEqual(candidate_text({"plainLyrics": " a\nb "}), "a\nb")
        self.assertEqual(candidate_text({"syncedLyrics": "[00:01.00]a\n[00:02.50] \n[01:03.4]b"}), "a\nb")
        self.assertEqual(candidate_text({}), "")
        cands = [{"duration": 180, "plainLyrics": "x"}, {"duration": 196, "plainLyrics": "y"}, {"duration": 195}]
        self.assertEqual(best_text_candidate(cands, 197)["plainLyrics"], "y")  # the closest one that HAS text
        self.assertIsNone(best_text_candidate([{"duration": 1}], 1))

    def test_file_with_timings_and_without_content(self):
        cues, source = resolve_lyrics("file", self.info(), "[00:01.00]a\n[00:03.00]b")
        self.assertEqual((source, len(cues)), ("file", 2))
        with self.assertRaises(ValueError):
            resolve_lyrics("file", self.info(), None)

    def test_lrclib_without_artist_and_title(self):
        with self.assertRaises(NeedsLyrics):
            resolve_lyrics("lrclib", self.info(), None)


class AlignTests(unittest.TestCase):
    class W:
        def __init__(self, start, end):
            self.start, self.end = start, end

    def test_clean_lines(self):
        self.assertEqual(clean_lines("  a \n\n b\n   \nc"), ["a", "b", "c"])
        # section markers are not sung; "(whoa, oh)" is sung and stays
        self.assertEqual(clean_lines("[Chorus]\nline one\n[Verse 2]\n(whoa, oh)\n[x] texto"), ["line one", "(whoa, oh)", "[x] texto"])

    def test_group_words_by_word_count(self):
        words = [self.W(1.0, 1.4), self.W(1.5, 2.0), self.W(2.1, 2.5), self.W(5.0, 5.5)]
        cues = group_words(["Lock me", "up", "again"], words)
        self.assertEqual(
            cues,
            [
                {"start": 1.0, "end": 2.0, "text": "Lock me", "words": [[1.0, 1.4], [1.5, 2.0]]},
                {"start": 2.1, "end": 2.5, "text": "up", "words": [[2.1, 2.5]]},
                {"start": 5.0, "end": 5.5, "text": "again", "words": [[5.0, 5.5]]},
            ],
        )

    def test_group_words_never_goes_back_in_time_and_gives_a_minimum_duration(self):
        words = [self.W(10.0, 10.0), self.W(4.0, 4.0)]  # an unaligned word, timed before the last line
        cues = group_words(["a", "b"], words)
        self.assertEqual(cues[1]["start"], 10.0)
        self.assertTrue(all(c["end"] - c["start"] >= 0.3 for c in cues))

    def test_word_timings_stay_inside_the_line_and_in_order(self):
        words = [self.W(1.0, 3.0), self.W(2.0, 2.2), self.W(2.5, 9.0)]  # the 2nd overlaps the 1st; the 3rd runs past the end
        (cue,) = group_words(["a b c"], words)
        times = cue["words"]
        self.assertEqual(len(times), 3)
        flat = [t for pair in times for t in pair]
        self.assertEqual(flat, sorted(flat))  # never goes back in time
        self.assertTrue(all(cue["start"] <= s <= e <= cue["end"] for s, e in times))

    def test_attach_words_keeps_the_lines_and_ignores_what_disagrees(self):
        cues = [
            {"start": 10.0, "end": 12.0, "text": "Lock me"},
            {"start": 20.0, "end": 22.0, "text": "up"},
            {"start": 30.0, "end": 32.0, "text": "again now"},
        ]
        aligned = [
            {"start": 10.3, "end": 12.1, "text": "Lock me", "words": [[10.3, 11.0], [11.2, 12.1]]},
            {"start": 27.0, "end": 28.0, "text": "up", "words": [[27.0, 28.0]]},  # the AI disagrees by 7 s: no words
            {"start": 30.0, "end": 32.0, "text": "again now", "words": [[30.0, 31.0]]},  # the count does not match
        ]
        out, done = attach_words(cues, aligned)
        self.assertEqual(done, 1)
        self.assertEqual([(c["start"], c["end"]) for c in out], [(10.0, 12.0), (20.0, 22.0), (30.0, 32.0)])  # lines intact
        self.assertEqual(out[0]["words"], [[10.3, 11.0], [11.2, 12.0]])  # held to the original line's end
        self.assertNotIn("words", out[1])
        self.assertNotIn("words", out[2])
        self.assertEqual(attach_words(cues, aligned[:2]), (cues, 0))  # the AI returned a different number of lines: nothing changes

    def test_group_words_refuses_when_the_count_does_not_match(self):
        with self.assertRaisesRegex(ValueError, "Não consegui sincronizar"):
            group_words(["duas palavras", "mais uma"], [self.W(0, 1)] * 2)

    def test_align_requires_lyrics(self):
        from singalong_worker.align import align_lyrics

        with self.assertRaises(ValueError):
            align_lyrics(Path("x.mp3"), "  \n ")


class KeyTests(unittest.TestCase):
    @staticmethod
    def rotate(profile, tonic):
        """A key's profile with the tonic at `tonic` (the inverse of the rotation best_key does)."""
        return profile[-tonic:] + profile[:-tonic] if tonic else list(profile)

    def test_recognizes_the_24_keys_from_their_own_profiles(self):
        for tonic in range(12):
            major = best_key(self.rotate(MAJOR_PROFILE, tonic))
            self.assertEqual((major["tonic"], major["mode"]), (tonic, "major"), f"maior {tonic}")
            minor = best_key(self.rotate(MINOR_PROFILE, tonic))
            self.assertEqual((minor["tonic"], minor["mode"]), (tonic, "minor"), f"menor {tonic}")

    def test_transposing_the_profile_moves_the_key_by_the_same_amount(self):
        base = [5, 0, 3, 0, 4, 3, 0, 5, 0, 3, 0, 2]  # C major's triad and scale, roughly
        for shift in (1, 2, 5, 7, 11):
            moved = base[-shift:] + base[:-shift]
            self.assertEqual(best_key(moved)["tonic"], (best_key(base)["tonic"] + shift) % 12)
            self.assertEqual(best_key(moved)["mode"], best_key(base)["mode"])

    def test_the_result_has_a_name_a_confidence_and_an_alternative(self):
        key = best_key(self.rotate(MINOR_PROFILE, 9))  # A minor
        self.assertEqual((key["name"], key["mode"]), ("A", "minor"))
        self.assertGreater(key["score"], 0.99)
        self.assertGreater(key["margin"], 0)
        self.assertIn(key["alt"]["mode"], ("major", "minor"))
        self.assertIn(key["alt"]["name"], NOTES)

    def test_an_ambiguous_profile_has_a_small_margin(self):
        # C major and A minor have the same notes: a "flat" profile leaves the two close
        flat = [1, 0, 1, 0, 1, 1, 0, 1, 0, 1, 0, 1]
        self.assertLess(best_key(flat)["margin"], 0.1)

    def test_invalid_inputs(self):
        with self.assertRaises(ValueError):
            best_key([0.0] * 12)  # silence
        with self.assertRaises(ValueError):
            best_key([1.0] * 11)

    def test_music_key_reuses_the_computed_key_and_never_brings_the_job_down(self):
        import json
        import tempfile
        from unittest import mock

        from singalong_worker import pipeline

        with tempfile.TemporaryDirectory() as root, tempfile.TemporaryDirectory() as work:
            storage = LocalStorage(root)
            k = pipeline.keys("abcdefghijk")
            meta = Path(work) / "meta.json"
            meta.write_text(json.dumps({"key": {"tonic": 9, "mode": "minor"}}), encoding="utf-8")
            storage.put(k["meta"], meta)
            with mock.patch.object(pipeline, "detect_key", side_effect=AssertionError("não deveria recalcular")):
                self.assertEqual(pipeline.music_key(storage, k, Path(work), None)["tonic"], 9)

            storage.delete("cache")  # no earlier meta and no instrumental: the analysis fails, the job goes on without a key
            self.assertIsNone(pipeline.music_key(storage, k, Path(work), None))

            audio = Path(work) / "instrumental.mp3"
            audio.write_bytes(b"x")
            with mock.patch.object(pipeline, "detect_key", return_value={"tonic": 2, "mode": "major"}) as detect:
                self.assertEqual(pipeline.music_key(storage, k, Path(work), audio)["tonic"], 2)
            detect.assert_called_once_with(audio)


class SearchTests(unittest.TestCase):
    def test_parse_entries(self):
        entries = [
            {"id": "TLvtw4nXou0", "title": "Jack's Lament", "channel": "Geoff", "duration": 265},
            {"id": "PLxxxxxxxxxxxxxxxxxx", "title": "playlist"},  # not a video (long ID)
            None,
            {"id": "dQw4w9WgXcQ", "uploader": "Rick"},
        ]
        out = parse_entries(entries)
        self.assertEqual([r["video_id"] for r in out], ["TLvtw4nXou0", "dQw4w9WgXcQ"])
        self.assertEqual(out[0], {"video_id": "TLvtw4nXou0", "title": "Jack's Lament", "channel": "Geoff", "duration": 265})
        self.assertEqual((out[1]["title"], out[1]["channel"]), ("dQw4w9WgXcQ", "Rick"))


class BackingTests(unittest.TestCase):
    def test_share_tells_a_single_voice_from_one_with_harmonies(self):
        import numpy as np

        t = np.arange(22050 * 20) / 22050
        lead = 0.3 * np.sin(2 * np.pi * 220 * t)  # lead vocals singing the whole time
        silent = np.zeros_like(lead)  # a single voice: the backing is (almost) silence
        harmony = np.where((t % 10) < 4, 0.2, 0.005) * np.sin(2 * np.pi * 330 * t)  # strong backing 40% of the time
        self.assertLess(backing_share(lead, silent), 0.01)
        self.assertGreater(backing_share(lead, harmony), 0.3)
        self.assertEqual(backing_share(silent, harmony), 0.0)  # without lead vocals there is nothing to compare
        self.assertEqual(backing_share(np.zeros(100), np.zeros(100)), 0.0)  # audio too short

    def test_usable_threshold(self):
        self.assertFalse(is_usable(0.0))
        self.assertFalse(is_usable(0.04))
        self.assertTrue(is_usable(0.05))
        self.assertTrue(is_usable(0.26))

    def test_find_missing_only_lists_analysed_songs_with_vocals(self):
        with tempfile.TemporaryDirectory() as d:
            storage = LocalStorage(d)
            root = Path(d) / "cache"
            for vid, meta, has_vocals in [
                ("aaaaaaaaaaa", {"title": "sem análise"}, True),  # not analyzed yet
                ("bbbbbbbbbbb", {"title": "feita", "backing": {"status": "ready", "share": 0.3}}, True),
                ("ccccccccccc", {"title": "sem apoio", "backing": {"status": "none", "share": 0.0}}, True),
                ("ddddddddddd", {"title": "sem a voz isolada"}, False),  # an old cache: cannot separate
            ]:
                (root / vid).mkdir(parents=True)
                (root / vid / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
                if has_vocals:
                    (root / vid / "vocals.mp3").write_bytes(b"x")
            self.assertEqual(find_missing(storage), ["aaaaaaaaaaa"])

    def test_process_refuses_a_song_that_is_not_ready(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(FileNotFoundError):
                backing_process(LocalStorage(d), "aaaaaaaaaaa")


class MetaStoreTests(unittest.TestCase):
    def test_concurrent_updates_do_not_overwrite_each_other(self):
        import threading

        with tempfile.TemporaryDirectory() as d:
            storage = LocalStorage(d)
            (Path(d) / "cache" / "aaaaaaaaaaa").mkdir(parents=True)
            (Path(d) / "cache" / "aaaaaaaaaaa" / "meta.json").write_text(json.dumps({"title": "T"}), encoding="utf-8")
            threads = [threading.Thread(target=update_meta, args=(storage, "aaaaaaaaaaa", lambda m, i=i: m.update({f"campo{i}": i}))) for i in range(30)]
            for th in threads:
                th.start()
            for th in threads:
                th.join()
            final = json.loads((Path(d) / "cache" / "aaaaaaaaaaa" / "meta.json").read_text(encoding="utf-8"))
            self.assertEqual(final["title"], "T")
            self.assertEqual({k for k in final if k.startswith("campo")}, {f"campo{i}" for i in range(30)})  # no change was lost


class TitlesBackfillTests(unittest.TestCase):
    def test_copies_the_video_title_from_source_to_meta(self):
        with tempfile.TemporaryDirectory() as d:
            storage = LocalStorage(d)
            root = Path(d) / "cache"
            for vid, meta, source in [
                ("aaaaaaaaaaa", {"title": "Unethical", "artist": "Faouzia"}, {"video_title": "Faouzia - Unethical (MAPHRA Vocal Cover)"}),
                ("bbbbbbbbbbb", {"title": "X", "video_title": "já tem"}, {"video_title": "outro"}),  # does not overwrite
                ("ccccccccccc", {"title": "Y"}, None),  # no source.json: skips
                ("ddddddddddd", {"title": "Z"}, {"video_title": None}),  # a source without a title: skips
            ]:
                (root / vid).mkdir(parents=True)
                (root / vid / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
                if source is not None:
                    (root / vid / "source.json").write_text(json.dumps(source), encoding="utf-8")
            self.assertEqual(titles_backfill(storage), 1)
            read = lambda vid: json.loads((root / vid / "meta.json").read_text(encoding="utf-8"))
            self.assertEqual(read("aaaaaaaaaaa"), {"title": "Unethical", "artist": "Faouzia", "video_title": "Faouzia - Unethical (MAPHRA Vocal Cover)"})
            self.assertEqual(read("bbbbbbbbbbb")["video_title"], "já tem")
            self.assertNotIn("video_title", read("ccccccccccc"))
            self.assertEqual(titles_backfill(storage), 0)  # idempotent


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
