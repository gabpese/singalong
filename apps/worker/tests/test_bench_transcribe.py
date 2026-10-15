"""A medição da transcrição (T1 da 1.4.0): erro de palavras, erro de tempo, confiança x erro e a escolha do modelo, sem Whisper nem áudio."""
import json
import tempfile
import unittest
from pathlib import Path

from singalong_worker import bench_transcribe as bench
from singalong_worker.storage import LocalStorage


class WordErrorTests(unittest.TestCase):
    def test_normalize_ignores_case_accents_and_punctuation(self):
        self.assertEqual(bench.tokens("Don't STOP, Believin'! Coração..."), ["dont", "stop", "believin", "coracao"])
        self.assertEqual(bench.tokens("  ♪ ... ♪ "), [])  # só símbolos: nenhuma palavra

    def test_identical_text_has_no_errors(self):
        ref = bench.tokens("tell me why you left me here")
        errors = bench.word_errors(ref, list(ref))
        self.assertEqual((errors["errors"], errors["wer"]), (0, 0.0))

    def test_counts_substitutions_deletions_and_insertions_separately(self):
        ref = ["a", "b", "c", "d"]
        self.assertEqual(bench.word_errors(ref, ["a", "x", "c", "d"])["substitutions"], 1)
        self.assertEqual(bench.word_errors(ref, ["a", "c", "d"])["deletions"], 1)
        self.assertEqual(bench.word_errors(ref, ["a", "b", "b", "c", "d"])["insertions"], 1)
        mixed = bench.word_errors(ref, ["a", "x", "d", "e"])  # custo mínimo 3; como trocar 3 palavras ou trocar 1, tirar 1 e pôr 1 empatam, só o total vale
        self.assertEqual((mixed["errors"], mixed["wer"]), (3, 0.75))
        self.assertEqual(mixed["substitutions"] + mixed["deletions"] + mixed["insertions"], 3)

    def test_a_hallucinated_loop_counts_as_insertions_and_can_pass_100_percent(self):
        ref = ["love", "me", "tender"]
        loop = ["love", "me", "tender"] + ["thank", "you"] * 5
        errors = bench.word_errors(ref, loop)
        self.assertEqual(errors["insertions"], 10)
        self.assertGreater(errors["wer"], 1.0)  # o Whisper que inventa letra em silêncio é pior que não ouvir nada

    def test_empty_reference_has_no_wer(self):
        self.assertIsNone(bench.word_errors([], ["a"])["wer"])
        self.assertEqual(bench.word_errors(["a"], [])["deletions"], 1)

    def test_alignment_pairs_every_word_once_and_in_order(self):
        ref, hyp = ["a", "b", "c"], ["a", "c", "d"]
        pairs = bench.align_words(ref, hyp)
        self.assertEqual([r for r, _ in pairs if r is not None], [0, 1, 2])
        self.assertEqual([h for _, h in pairs if h is not None], [0, 1, 2])


class ReferenceTests(unittest.TestCase):
    CUES = [{"start": 10.0 + i * 5, "end": 13.0 + i * 5, "text": f"line {i} here we go"} for i in range(12)]  # 10 s a 68 s

    def test_window_keeps_only_the_lines_that_fit_with_times_relative_to_the_start(self):
        window = bench.reference_window(self.CUES, 20.0, 20.0)  # 20 s a 40 s: as linhas que começam em 20, 25, 30, 35 (a de 40 passa de 40+folga? termina 43)
        self.assertEqual(window["lines"], 4)
        self.assertEqual(window["line_starts"], [0.0, 5.0, 10.0, 15.0])
        self.assertEqual(len(window["words"]), 4 * 5)
        self.assertEqual(window["line_of"][:6], [0, 0, 0, 0, 0, 1])

    def test_lines_without_text_are_skipped(self):
        cues = [{"start": 1.0, "end": 2.0, "text": ""}, {"start": 3.0, "end": 4.0, "text": "hello there"}]
        self.assertEqual(bench.reference_window(cues, 0.0, 10.0)["lines"], 1)

    def test_excerpt_starts_a_quarter_of_the_way_in_and_never_runs_past_the_song(self):
        start, length = bench.pick_excerpt(self.CUES, 30.0)
        self.assertEqual((start, length), (24.0, 30.0))  # a linha 3 (25 s), um segundo antes
        self.assertEqual(bench.pick_excerpt(self.CUES, 30.0, duration=40.0)[0], 10.0)  # música curta: recua para caber
        self.assertEqual(bench.pick_excerpt([], 30.0), (0.0, 30.0))

    def test_line_start_error_uses_the_first_word_the_whisper_matched_in_each_line(self):
        window = {"words": ["a", "b", "c", "d"], "line_of": [0, 0, 1, 1], "line_starts": [0.0, 5.0], "lines": 2}
        hyp = ["a", "b", "c", "d"]
        pairs = bench.align_words(window["words"], hyp)
        errors = bench.line_start_errors(window, [0.4, 1.0, 5.1, 6.0], pairs)
        self.assertEqual(errors, [0.4, 0.1])
        # a primeira palavra da linha 1 sumiu: vale a segunda
        hyp2 = ["a", "b", "d"]
        errors2 = bench.line_start_errors(window, [0.0, 1.0, 6.5], bench.align_words(window["words"], hyp2))
        self.assertEqual(errors2, [0.0, 1.5])
        # linha inteira sem nenhuma palavra ouvida: sem erro de tempo medido para ela
        errors3 = bench.line_start_errors(window, [0.0, 1.0], bench.align_words(window["words"], ["a", "b"]))
        self.assertEqual(errors3, [0.0])


class ConfidenceTests(unittest.TestCase):
    def test_wrong_fraction_per_segment(self):
        ref = ["a", "b", "c", "d", "e", "f"]
        hyp = ["a", "b", "c", "x", "y", "f"]
        pairs = bench.align_words(ref, hyp)
        segments = [{"first": 0, "count": 3, "avg_logprob": -0.2}, {"first": 3, "count": 3, "avg_logprob": -1.4}]
        out = bench.segment_wrong_fractions(segments, pairs, ref, hyp)
        self.assertEqual([o["wrong"] for o in out], [0.0, 0.667])
        self.assertEqual(out[1]["avg_logprob"], -1.4)
        self.assertNotIn("first", out[0])

    def test_empty_segments_are_ignored(self):
        self.assertEqual(bench.segment_wrong_fractions([{"first": 0, "count": 0}], [], [], []), [])

    def test_threshold_separates_the_bad_segments_and_reports_the_api_cost(self):
        # trechos ruins têm avg_logprob baixo: o corte certo fica entre -1.0 e -0.5
        samples = [{"avg_logprob": -0.2, "wrong": 0.0, "words": 10}, {"avg_logprob": -0.3, "wrong": 0.1, "words": 10},
                   {"avg_logprob": -0.4, "wrong": 0.1, "words": 10}, {"avg_logprob": -1.0, "wrong": 0.7, "words": 5},
                   {"avg_logprob": -1.3, "wrong": 0.9, "words": 5}]
        best = bench.suggest_threshold(samples)
        self.assertEqual(best["cut"], -1.0)
        self.assertEqual((best["precision"], best["recall"]), (1.0, 1.0))
        self.assertEqual(best["api_share_of_words"], round(10 / 40, 3))  # só 25% das palavras iriam à API

    def test_threshold_is_none_without_bad_segments_or_without_confidence(self):
        self.assertIsNone(bench.suggest_threshold([{"avg_logprob": -0.2, "wrong": 0.0, "words": 10}]))
        self.assertIsNone(bench.suggest_threshold([{"avg_logprob": None, "wrong": 0.9, "words": 10}]))
        self.assertIsNone(bench.suggest_threshold([]))

    def test_a_threshold_that_flags_everything_is_not_better_than_a_precise_one(self):
        samples = [{"avg_logprob": -0.1 * i, "wrong": 0.0 if i < 8 else 0.9, "words": 10} for i in range(10)]
        best = bench.suggest_threshold(samples)
        self.assertLess(best["api_share_of_words"], 0.5)


class CatalogMatchTests(unittest.TestCase):
    LYRICS = {
        "a": bench.tokens("hello darkness my old friend i have come to talk with you again"),
        "b": bench.tokens("tell me why ain't nothing but a heartache tell me why ain't nothing but a mistake"),
        "c": bench.tokens("we will we will rock you buddy you are a boy make a big noise playing in the street"),
    }

    def test_an_excerpt_is_contained_in_its_own_lyrics_and_not_in_the_others(self):
        excerpt = bench.tokens("darkness my old friend i have come to talk")
        self.assertEqual(bench.containment(excerpt, self.LYRICS["a"]), 1.0)
        self.assertEqual(bench.containment(excerpt, self.LYRICS["b"]), 0.0)

    def test_a_noisy_transcription_still_scores_high_on_the_right_lyrics(self):
        noisy = bench.tokens("darkness my old fiend i have come to talk with")  # uma palavra errada
        right = bench.containment(noisy, self.LYRICS["a"])
        self.assertGreater(right, 0.7)
        self.assertLess(bench.containment(noisy, self.LYRICS["c"]), 0.1)

    def test_too_short_or_empty_text_scores_zero(self):
        self.assertEqual(bench.containment(["a"], ["a", "b"]), 0.0)
        self.assertEqual(bench.containment([], ["a", "b"]), 0.0)
        self.assertEqual(bench.containment(["a", "b"], []), 0.0)

    def test_separable_when_every_right_pair_beats_every_wrong_pair(self):
        heard = {"a": bench.tokens("darkness my old fiend i have come to talk"), "b": bench.tokens("tell me why ain't nothing but a hartache"),
                 "c": bench.tokens("we will we will rock you buddy you are a boy")}
        match = bench.catalog_match(heard, self.LYRICS)
        self.assertTrue(match["separable"])
        self.assertEqual(match["pairs"], {"right": 3, "wrong": 6})
        self.assertGreater(match["right_min"], match["wrong_max"])
        self.assertTrue(match["wrong_max"] < match["threshold"] < match["right_min"])  # o limiar fica entre os dois grupos

    def test_not_separable_when_a_wrong_song_looks_like_the_right_one(self):
        # outra música cuja letra repete o trecho ouvido (um refrão em comum), mas que não é a mesma letra
        hook = bench.tokens("darkness my old friend i have come to talk")
        lyrics = {"a": self.LYRICS["a"], "other": hook + bench.tokens("something else entirely nobody knows here today at all")}
        match = bench.catalog_match({"a": hook}, lyrics)
        self.assertFalse(match["separable"])
        self.assertIsNone(match["threshold"])

    def test_two_versions_of_the_same_song_are_not_wrong_pairs(self):
        lyrics = {"a": self.LYRICS["a"], "a2": list(self.LYRICS["a"]), "b": self.LYRICS["b"]}  # a e a2: a mesma letra (duas versões na biblioteca)
        match = bench.catalog_match({"a": bench.tokens("darkness my old friend i have come to talk")}, lyrics)
        self.assertTrue(match["separable"])
        self.assertEqual(match["pairs"], {"right": 1, "wrong": 1})  # só "b" conta como errado
        self.assertTrue(bench.same_lyrics(self.LYRICS["a"], list(self.LYRICS["a"])))
        self.assertFalse(bench.same_lyrics(self.LYRICS["a"], self.LYRICS["b"]))

    def test_no_match_without_pairs(self):
        self.assertIsNone(bench.catalog_match({}, {}))
        self.assertIsNone(bench.catalog_match({"a": ["x", "y"]}, {"a": ["x", "y"]}))  # sem nenhum par errado para comparar


class VoteReportTests(unittest.TestCase):
    def heard(self, text, probs=0.9):
        return {"words": [{"token": t, "text": t, "start": float(i), "prob": probs} for i, t in enumerate(text.split())], "segments": [], "language": None}

    def test_the_vote_is_scored_like_a_single_model_and_compared_with_each_one(self):
        window = {"words": "my old friend i have come".split(), "line_of": [0, 0, 0, 1, 1, 1], "line_starts": [0.0, 3.0], "lines": 2}
        prepared = [{"id": "s1", "window": window, "group": "original", "length": 90.0}]
        heard = {
            "medium": {"s1": self.heard("my old fiend i have come")},  # um erro
            "turbo": {"s1": self.heard("my old friend i have come")},
            "small": {"s1": self.heard("my old friend i have comb")},  # outro erro, em outro lugar
        }
        singles = {m: bench.summarize([{**bench.score_song(window, h["s1"]), "seconds": 1.0, "audio_seconds": 90.0}]) for m, h in heard.items()}
        out = bench.vote_report(prepared, heard, [["medium", "turbo", "small"]], singles)
        summary = out["medium+turbo+small"]["summary"]
        self.assertEqual(summary["wer_pooled"], 0.0)  # cada erro estava só em um modelo: o voto os corrige
        self.assertEqual(summary["vote_changes"], 1)  # o voto conta o que mudou em relação ao pivô: só o "fiend" do medium; o erro do small nem entrou
        self.assertEqual(summary["vs_single"]["medium"], -round(1 / 6, 3))  # melhor que o medium sozinho
        self.assertEqual(summary["vs_single"]["turbo"], 0.0)  # e igual ao melhor
        self.assertEqual(out["medium+turbo+small"]["per_song"][0]["vote"]["changed"], 1)

    def test_a_combination_with_a_missing_model_is_skipped(self):
        window = {"words": ["a", "b"], "line_of": [0, 0], "line_starts": [0.0], "lines": 1}
        prepared = [{"id": "s1", "window": window, "group": "original", "length": 90.0}]
        heard = {"medium": {"s1": self.heard("a b")}}
        self.assertEqual(bench.vote_report(prepared, heard, [["medium", "turbo"]], {}), {})


class BestSignalTests(unittest.TestCase):
    def test_picks_the_signal_that_separates_best(self):
        samples = [
            {"avg_logprob": -0.3, "mean_word_prob": 0.9, "wrong": 0.0, "words": 10},
            {"avg_logprob": -0.9, "mean_word_prob": 0.8, "wrong": 0.1, "words": 10},  # o avg_logprob confunde este trecho bom com um ruim
            {"avg_logprob": -1.0, "mean_word_prob": 0.3, "wrong": 0.8, "words": 10},
            {"avg_logprob": -0.35, "mean_word_prob": 0.35, "wrong": 0.9, "words": 10},  # e este ruim parece bom
        ]
        found = bench.best_signal(samples)
        self.assertEqual(found["best"], "mean_word_prob")
        self.assertEqual(found["signals"]["mean_word_prob"]["cut"], 0.35)

    def test_no_best_without_bad_segments(self):
        found = bench.best_signal([{"avg_logprob": -0.1, "mean_word_prob": 0.9, "wrong": 0.0, "words": 5}])
        self.assertIsNone(found["best"])


class SummaryTests(unittest.TestCase):
    def song(self, wer, errors, ref, starts, seconds=10.0, audio=90.0):
        return {"wer": wer, "errors": errors, "ref_words": ref, "line_start_errors": starts, "seconds": seconds, "audio_seconds": audio}

    def test_summary_pools_the_words_and_reports_speed(self):
        songs = [self.song(0.1, 10, 100, [0.2, 0.4]), self.song(0.5, 100, 200, [2.0, 0.6])]
        s = bench.summarize(songs)
        self.assertEqual(s["songs"], 2)
        self.assertEqual(s["wer_pooled"], round(110 / 300, 3))
        self.assertEqual(s["wer_median"], 0.3)
        self.assertEqual(s["line_start_median_s"], 0.5)
        self.assertEqual(s["line_start_within_1s"], 0.75)
        self.assertEqual(s["realtime_factor"], round(20 / 180, 3))
        self.assertEqual(bench.summarize([])["songs"], 0)

    def test_recommends_the_fastest_model_close_to_the_best_wer(self):
        summaries = {
            "base": {"songs": 8, "wer_pooled": 0.40, "realtime_factor": 0.05},
            "small": {"songs": 8, "wer_pooled": 0.27, "realtime_factor": 0.2},
            "medium": {"songs": 8, "wer_pooled": 0.25, "realtime_factor": 0.6},
            "turbo": {"songs": 8, "wer_pooled": 0.24, "realtime_factor": 0.3},
        }
        rec = bench.recommend(summaries)
        self.assertEqual(rec["model"], "small")  # 0,27 está a 3 pontos do melhor (0,24) e é o mais rápido dos que chegam perto
        self.assertEqual(bench.recommend(summaries, tolerance=0.0)["model"], "turbo")
        self.assertIsNone(bench.recommend({"base": {"songs": 0}}))

    def test_table_shows_every_group_and_the_recommendation(self):
        report = {
            "models": {"small": {"todas": {"songs": 2, "wer_pooled": 0.3, "wer_median": 0.25, "line_start_median_s": 0.4, "line_start_within_1s": 0.9, "realtime_factor": 0.2},
                                  "cover": {"songs": 1, "wer_pooled": 0.5, "wer_median": 0.5, "line_start_median_s": None, "line_start_within_1s": None, "realtime_factor": 0.2},
                                  "original": {"songs": 0}}},
            "recommendation": {"model": "small", "wer_pooled": 0.3, "best_wer": 0.3, "realtime_factor": 0.2},
            "thresholds": {"small": {"best": "mean_word_prob", "signals": {
                "avg_logprob": {"cut": -0.9, "recall": 0.6, "precision": 0.5, "api_share_of_words": 0.3},
                "mean_word_prob": {"cut": 0.55, "recall": 0.8, "precision": 0.7, "api_share_of_words": 0.2}}}},
            "catalog_match": {"small": {"right_min": 0.7, "right_median": 0.85, "wrong_max": 0.2, "wrong_median": 0.05, "separable": True, "threshold": 0.45}},
        }
        text = bench.render_table(report)
        self.assertIn("small", text)
        self.assertIn("cover", text)
        self.assertNotIn("original", text)  # grupo sem músicas não aparece
        self.assertIn("Modelo padrão sugerido: small", text)
        self.assertIn("small, avg_logprob): <= -0.9", text)
        self.assertIn("small, mean_word_prob (melhor sinal)): <= 0.55", text)
        self.assertIn("Escolher a letra do catálogo pelo áudio (small): par certo >= 0.7", text)
        self.assertIn("limiar 0.45", text)


class ScoreSongTests(unittest.TestCase):
    def test_scores_a_window_against_what_the_whisper_heard(self):
        window = {"words": ["hello", "darkness", "my", "old", "friend"], "line_of": [0, 0, 0, 1, 1], "line_starts": [0.0, 4.0], "lines": 2}
        heard = {
            "words": [{"token": t, "start": s, "prob": 0.9} for t, s in (("hello", 0.1), ("darkness", 0.8), ("my", 1.5), ("old", 4.3), ("fiend", 5.0))],
            "segments": [{"first": 0, "count": 3, "avg_logprob": -0.1}, {"first": 3, "count": 2, "avg_logprob": -1.2}],
            "language": "en",
        }
        scored = bench.score_song(window, heard)
        self.assertEqual((scored["errors"], scored["wer"]), (1, 0.2))  # "fiend" no lugar de "friend"
        self.assertEqual(scored["line_start_errors"], [0.1, 0.3])
        self.assertEqual([s["wrong"] for s in scored["segments"]], [0.0, 0.5])
        self.assertEqual(scored["language"], "en")


class LibraryTests(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)

    def add(self, video_id, source, lines=8, vocals=True):
        folder = self.root / "cache" / video_id
        folder.mkdir(parents=True)
        (folder / "meta.json").write_text(json.dumps({"title": f"Música {video_id}", "artist": "Artista", "duration": 200, "lyrics_source": source}), encoding="utf-8")
        (folder / "lyrics.json").write_text(json.dumps([{"start": i * 4.0, "end": i * 4.0 + 3, "text": f"verso {i} da letra"} for i in range(lines)]), encoding="utf-8")
        if vocals:
            (folder / "vocals.mp3").write_bytes(b"x")

    def test_only_songs_with_human_lyrics_and_the_isolated_vocals_are_ground_truth(self):
        self.add("aaaaaaaaaaa", "lrclib")
        self.add("bbbbbbbbbbb", "video")
        self.add("ccccccccccc", "align")  # letra de IA: não serve
        self.add("ddddddddddd", "lrclib+align")  # o tempo é da IA: não serve
        self.add("eeeeeeeeeee", "lrclib", vocals=False)  # sem a voz isolada
        self.add("fffffffffff", "lrclib", lines=3)  # letra curta demais
        ids = [s["id"] for s in bench.eligible_songs(LocalStorage(self.root))]
        self.assertEqual(ids, ["aaaaaaaaaaa", "bbbbbbbbbbb"])
        only = [s["id"] for s in bench.eligible_songs(LocalStorage(self.root), {"bbbbbbbbbbb"})]
        self.assertEqual(only, ["bbbbbbbbbbb"])

    def test_empty_library(self):
        self.assertEqual(bench.eligible_songs(LocalStorage(self.root)), [])

    def test_list_option_prints_the_ground_truth_without_loading_whisper(self):
        self.add("aaaaaaaaaaa", "lrclib")
        import io
        from contextlib import redirect_stdout

        out = io.StringIO()
        with redirect_stdout(out):
            code = bench.main(["--storage-root", str(self.root), "--list"])
        self.assertEqual(code, 0)
        self.assertIn("aaaaaaaaaaa", out.getvalue())
        self.assertIn("lrclib", out.getvalue())


if __name__ == "__main__":
    unittest.main()
