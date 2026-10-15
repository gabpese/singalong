"""O voto entre transcrições: maioria, mediano do tempo, desempate por confiança e prioridade, inserções e remoções."""
import unittest

from singalong_worker import consensus
from singalong_worker.textmatch import align_words, containment, normalize_word, same_lyrics, tokens


def source(name, text, starts=None, probs=None, weight=1.0):
    """Uma fonte de mentira: as palavras de `text`, com tempos e probabilidades (padrão: 1 s a mais por palavra e 0,9)."""
    words = text.split()
    return {"name": name, "weight": weight, "words": [
        {"token": normalize_word(w), "text": w, "start": (starts[i] if starts else float(i)), "prob": (probs[i] if probs else 0.9)} for i, w in enumerate(words)]}


def result(out):
    return " ".join(w["text"] for w in out["words"])


class TextMatchTests(unittest.TestCase):
    def test_normalize_tokens_and_alignment(self):
        self.assertEqual(tokens("Don't STOP, Believin'! Coração"), ["dont", "stop", "believin", "coracao"])
        pairs = align_words(["a", "b", "c"], ["a", "c", "d"])
        self.assertEqual([r for r, _ in pairs if r is not None], [0, 1, 2])

    def test_containment_and_same_lyrics(self):
        a = tokens("hello darkness my old friend i have come to talk")
        self.assertEqual(containment(tokens("darkness my old friend"), a), 1.0)
        self.assertEqual(containment(tokens("something else entirely"), a), 0.0)
        self.assertTrue(same_lyrics(a, list(a)))
        self.assertFalse(same_lyrics(a, tokens("tell me why ain't nothing but a heartache")))


class VoteTests(unittest.TestCase):
    def test_unanimous_sources_come_out_unchanged(self):
        out = consensus.vote([source("a", "hello darkness my old friend"), source("b", "hello darkness my old friend"), source("c", "hello darkness my old friend")])
        self.assertEqual(result(out), "hello darkness my old friend")
        self.assertEqual(out["stats"]["unanimous"], 5)
        self.assertEqual(out["stats"]["changed"], 0)

    def test_the_majority_fixes_a_mistake_of_the_priority_source(self):
        # o pivô (a) ouviu "fiend"; b e c ouviram "friend": o voto corrige
        out = consensus.vote([source("a", "my old fiend"), source("b", "my old friend"), source("c", "my old friend")])
        self.assertEqual(result(out), "my old friend")
        self.assertEqual(out["stats"]["changed"], 1)
        self.assertEqual(out["stats"]["majority"], 1)
        fixed = out["words"][2]
        self.assertEqual((fixed["votes"], fixed["of"]), (2, 3))

    def test_the_start_of_a_word_is_the_median_of_the_sources_that_confirmed_it(self):
        out = consensus.vote([source("a", "hello", starts=[1.0]), source("b", "hello", starts=[1.4]), source("c", "hello", starts=[3.0])])
        self.assertEqual(out["words"][0]["start"], 1.4)  # o mediano, e o 3,0 de uma fonte fora da curva não puxa
        out2 = consensus.vote([source("a", "hello", starts=[1.0]), source("b", "hello", starts=[1.4])])
        self.assertEqual(out2["words"][0]["start"], 1.2)  # com duas fontes o mediano é a média

    def test_the_time_comes_only_from_the_sources_that_voted_for_the_winner(self):
        out = consensus.vote([source("a", "fiend", starts=[9.0]), source("b", "friend", starts=[2.0]), source("c", "friend", starts=[2.2])])
        self.assertEqual(out["words"][0]["start"], 2.1)  # o 9,0 era de quem perdeu

    def test_two_sources_tie_goes_to_the_more_confident_word(self):
        out = consensus.vote([source("local", "my old fiend", probs=[0.9, 0.9, 0.3]), source("api", "my old friend", probs=[0.9, 0.9, 0.95])])
        self.assertEqual(result(out), "my old friend")
        self.assertEqual(out["words"][2]["source"], "api")
        self.assertEqual(out["stats"]["undecided"], 1)

    def test_a_perfect_tie_goes_to_the_priority_source(self):
        out = consensus.vote([source("first", "red"), source("second", "blue")])
        self.assertEqual(result(out), "red")

    def test_a_heavier_source_can_beat_the_majority(self):
        # a letra do catálogo (peso 3) vale mais que duas transcrições juntas
        out = consensus.vote([source("catalogo", "my old friend", weight=3.0), source("a", "my old fiend"), source("b", "my old fiend")])
        self.assertEqual(result(out), "my old friend")
        out2 = consensus.vote([source("catalogo", "my old friend", weight=1.0), source("a", "my old fiend"), source("b", "my old fiend")])
        self.assertEqual(result(out2), "my old fiend")

    def test_a_word_only_the_pivot_heard_is_dropped_when_the_others_agree_it_is_not_there(self):
        out = consensus.vote([source("a", "hello uh darkness"), source("b", "hello darkness"), source("c", "hello darkness")])
        self.assertEqual(result(out), "hello darkness")
        self.assertEqual(out["stats"]["removed"], 1)

    def test_a_word_the_pivot_missed_is_added_when_most_sources_heard_it(self):
        out = consensus.vote([source("a", "hello darkness"), source("b", "hello my darkness"), source("c", "hello my darkness")])
        self.assertEqual(result(out), "hello my darkness")
        self.assertEqual(out["stats"]["added"], 1)

    def test_a_word_only_one_source_invented_is_not_added(self):
        out = consensus.vote([source("a", "hello darkness"), source("b", "hello thank you darkness"), source("c", "hello darkness")])
        self.assertEqual(result(out), "hello darkness")  # a alucinação de uma fonte não entra

    def test_with_two_sources_an_insertion_needs_both(self):
        self.assertEqual(result(consensus.vote([source("a", "hello darkness"), source("b", "hello my darkness")])), "hello darkness")

    def test_the_text_keeps_the_capitals_and_punctuation_of_the_source_that_won(self):
        out = consensus.vote([source("a", "Hello, Darkness"), source("b", "hello darkness"), source("c", "hello darkness")])
        self.assertEqual(result(out), "Hello, Darkness")  # a de maior prioridade entre as que concordam

    def test_sources_without_words_are_ignored_and_one_source_passes_through(self):
        failed_api = {"name": "api", "words": []}
        out = consensus.vote([source("local", "hello darkness"), failed_api])
        self.assertEqual(result(out), "hello darkness")
        self.assertEqual(out["stats"]["sources"], 1)
        self.assertEqual(consensus.vote([failed_api])["words"], [])
        self.assertEqual(consensus.vote([])["words"], [])

    def test_words_without_time_or_confidence_still_vote(self):
        bare = lambda name, text: {"name": name, "words": [{"token": normalize_word(w), "text": w} for w in text.split()]}  # noqa: E731
        out = consensus.vote([bare("a", "red car"), bare("b", "red car"), bare("c", "red bar")])
        self.assertEqual(result(out), "red car")
        self.assertIsNone(out["words"][0]["start"])

    def test_it_never_loses_a_correct_word_that_all_sources_share(self):
        text = "we were both young when i first saw you"
        out = consensus.vote([source("a", text), source("b", text), source("c", "we were both young when i first saw you")])
        self.assertEqual(result(out), text)
        self.assertEqual(out["stats"], {"sources": 3, "unanimous": 9, "majority": 0, "undecided": 0, "changed": 0, "removed": 0, "added": 0})


if __name__ == "__main__":
    unittest.main()
