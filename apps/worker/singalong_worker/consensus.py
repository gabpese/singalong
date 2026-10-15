"""O voto entre transcrições da mesma voz: várias fontes ouvem a mesma música (o Whisper local, o Whisper da API, a letra do catálogo) e erram
em lugares diferentes; onde elas divergem por pouco, vale a palavra que a maioria confirma, e o tempo da palavra é o MEDIANO dos tempos
das fontes que a confirmaram.

Funciona como o ROVER dos reconhecedores de fala: a fonte de maior prioridade (a primeira da lista) é o "pivô"; as outras são alinhadas a
ela palavra a palavra (textmatch.align_words); em cada posição as palavras concorrem, cada voto com a força `peso x (0,5 + confiança)`; um
voto para "essa palavra não existe" vale `peso`. Em empate, ganha a fonte de maior prioridade. Uma palavra a mais que só uma fonte ouviu
(inserção) só entra se as fontes que a ouviram passam de metade do peso total.

Com DUAS fontes não há mediano, só empate (decide a confiança e depois a prioridade); com três ou mais, há maioria de verdade.
Só biblioteca padrão."""
from statistics import median

from .textmatch import align_words


def _confidence(word: dict) -> float:
    prob = word.get("prob")
    return 0.5 if prob is None else min(max(float(prob), 0.0), 1.0)


def _median_start(words: list[dict]) -> float | None:
    starts = [w["start"] for w in words if w.get("start") is not None]
    return round(median(starts), 2) if starts else None


def _merged(token: str, voters: list[tuple[int, dict]], sources: list[dict], of: int) -> dict:
    """A palavra do resultado: o texto da fonte de maior prioridade entre as que votaram, o tempo mediano e a confiança média."""
    k, first = min(voters, key=lambda v: v[0])
    return {
        "token": token, "text": first.get("text", token), "start": _median_start([w for _, w in voters]),
        "prob": round(sum(_confidence(w) for _, w in voters) / len(voters), 3), "votes": len(voters), "of": of, "source": sources[k].get("name", str(k)),
    }


def vote(sources: list[dict]) -> dict:
    """`sources`: [{"name": str, "weight": float (padrão 1.0), "words": [{"token", "text", "start", "prob"}]}], em ordem de prioridade.
    Devolve {"words": [...], "stats": {...}}: as palavras do resultado (cada uma com `votes`/`of`) e quantas posições foram unânimes, decididas
    por maioria, decididas por confiança/prioridade (sem maioria) e quantas palavras do pivô o voto trocou, tirou ou acrescentou.
    Fontes sem nenhuma palavra (uma API que falhou) são ignoradas."""
    srcs = [s for s in sources if s.get("words")]
    stats = {"sources": len(srcs), "unanimous": 0, "majority": 0, "undecided": 0, "changed": 0, "removed": 0, "added": 0}
    if not srcs:
        return {"words": [], "stats": stats}
    if len(srcs) == 1:
        only = srcs[0]
        words = [{"token": w["token"], "text": w.get("text", w["token"]), "start": w.get("start"), "prob": w.get("prob"), "votes": 1, "of": 1,
                  "source": only.get("name", "0")} for w in only["words"]]
        stats["unanimous"] = len(words)
        return {"words": words, "stats": stats}
    weights = [float(s.get("weight", 1.0)) for s in srcs]
    pivot = srcs[0]["words"]
    slots: list[list[tuple[int, dict | None]]] = [[(0, w)] for w in pivot]
    gaps: list[dict[int, list[dict]]] = [{} for _ in range(len(pivot) + 1)]  # gaps[g]: o que cada fonte ouviu a mais ANTES da palavra g do pivô
    for k in range(1, len(srcs)):
        words = srcs[k]["words"]
        seen = 0
        for r, h in align_words([w["token"] for w in pivot], [w["token"] for w in words]):
            if r is None:
                gaps[seen].setdefault(k, []).append(words[h])
            else:
                slots[r].append((k, words[h] if h is not None else None))
                seen = r + 1
    total = sum(weights)
    out: list[dict] = []
    for g in range(len(pivot) + 1):
        out.extend(_inserted(gaps[g], weights, total, srcs, stats))
        if g == len(pivot):
            break
        scores: dict[str | None, list] = {}
        for k, word in slots[g]:
            key = None if word is None else word["token"]
            strength = weights[k] if word is None else weights[k] * (0.5 + _confidence(word))
            entry = scores.setdefault(key, [0.0, []])
            entry[0] += strength
            entry[1].append((k, word))
        key, (_, voters) = max(scores.items(), key=lambda kv: (round(kv[1][0], 9), -min(k for k, _ in kv[1][1])))
        if len(voters) == len(srcs):
            stats["unanimous"] += 1
        elif len(voters) * 2 > len(srcs):
            stats["majority"] += 1
        else:
            stats["undecided"] += 1
        if key is None:
            stats["removed"] += 1
            continue
        if key != pivot[g]["token"]:
            stats["changed"] += 1
        out.append(_merged(key, voters, srcs, len(srcs)))
    return {"words": out, "stats": stats}


def _inserted(gap: dict[int, list[dict]], weights: list[float], total: float, srcs: list[dict], stats: dict) -> list[dict]:
    """As palavras que algumas fontes ouviram entre duas palavras do pivô: entram só as que as fontes de mais da metade do peso ouviram."""
    by_token: dict[str, list[tuple[int, dict]]] = {}
    for k, words in gap.items():
        for token in dict.fromkeys(w["token"] for w in words):  # uma vez por fonte
            by_token.setdefault(token, []).append((k, next(w for w in words if w["token"] == token)))
    kept = []
    for token, voters in by_token.items():
        if sum(weights[k] for k, _ in voters) * 2 > total:
            kept.append(_merged(token, voters, srcs, len(srcs)))
            stats["added"] += 1
    return sorted(kept, key=lambda w: (w["start"] is None, w["start"] or 0.0))
