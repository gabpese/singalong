"""Comparação de texto de letra: normalizar palavras, alinhar duas sequências de palavras e medir o quanto uma letra está contida em outra.

Usado pela escolha da letra do catálogo pelo áudio, pelo voto entre transcrições (consensus.py) e pela medição (bench_transcribe.py).
Só biblioteca padrão."""
import unicodedata


def normalize_word(word: str) -> str:
    """Minúsculas, sem acento e sem pontuação: "Don't," e "dont" são a mesma palavra."""
    text = unicodedata.normalize("NFKD", str(word)).lower()
    return "".join(ch for ch in text if ch.isalnum())


def tokens(text: str) -> list[str]:
    return [n for n in (normalize_word(w) for w in str(text).split()) if n]


def align_words(ref: list[str], hyp: list[str]) -> list[tuple[int | None, int | None]]:
    """O alinhamento de menor custo (Levenshtein) entre duas sequências de palavras: pares (índice em ref, índice em hyp); None do lado
    que não tem par (palavra que faltou ou que sobrou). Trocas contam como um par com palavras diferentes."""
    n, m = len(ref), len(hyp)
    cost = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(1, n + 1):
        cost[i][0] = i
    for j in range(1, m + 1):
        cost[0][j] = j
    for i in range(1, n + 1):
        for j in range(1, m + 1):
            cost[i][j] = min(cost[i - 1][j - 1] + (ref[i - 1] != hyp[j - 1]), cost[i - 1][j] + 1, cost[i][j - 1] + 1)
    pairs, i, j = [], n, m
    while i > 0 or j > 0:
        if i > 0 and j > 0 and cost[i][j] == cost[i - 1][j - 1] + (ref[i - 1] != hyp[j - 1]):
            pairs.append((i - 1, j - 1))
            i, j = i - 1, j - 1
        elif i > 0 and cost[i][j] == cost[i - 1][j] + 1:
            pairs.append((i - 1, None))
            i -= 1
        else:
            pairs.append((None, j - 1))
            j -= 1
    return pairs[::-1]


def containment(hyp: list[str], ref: list[str], n: int = 2) -> float:
    """Que parte dos pares de palavras seguidas (bigramas) do que o Whisper ouviu aparece na letra candidata. Serve para um TRECHO ouvido
    contra uma letra INTEIRA (por isso é "contida em", e não uma simetria): 1.0 = o trecho está todo na letra; perto de 0 = é outra música."""
    grams = [tuple(hyp[i:i + n]) for i in range(len(hyp) - n + 1)]
    if not grams:
        return 0.0
    pool = {tuple(ref[i:i + n]) for i in range(len(ref) - n + 1)}
    return round(sum(1 for g in grams if g in pool) / len(grams), 3)


def same_lyrics(a: list[str], b: list[str], at_least: float = 0.8) -> bool:
    """As duas letras são praticamente a mesma (o cover e o original, ou duas versões): cada uma está quase toda contida na outra."""
    return min(containment(a, b), containment(b, a)) >= at_least
