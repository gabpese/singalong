"""Mede quanto o Whisper acerta ao TRANSCREVER a voz isolada de uma música (T1 do plano da 1.4.0): o erro de palavras (WER), o erro de tempo
e quanto demora, por modelo. O gabarito são as músicas da biblioteca que JÁ têm letra de gente (a LRCLIB ou a legenda do vídeo): a letra
sincronizada delas é comparada com o que o Whisper ouviu na mesma voz. Nada vai para fora do computador e nenhuma letra entra no relatório.

    python -m singalong_worker.bench_transcribe --storage-root <biblioteca> [--models base,small,medium,turbo] [--excerpt 90]
                                                [--covers ids.txt] [--only ID,ID] [--limit N] [--device cuda|cpu] [--out relatório.json]
    python -m singalong_worker.bench_transcribe --storage-root <biblioteca> --list      (só mostra o que serve de gabarito)

Para que serve cada número:
- WER: palavras erradas (trocadas, que faltam ou a mais) sobre as palavras da letra. Escolhe o modelo padrão.
- erro de início de linha: o quanto o Whisper erra o momento em que cada verso começa (a LRCLIB só tem o tempo da linha, não o da palavra).
- confiança x erro: mostra se os trechos em que o Whisper "duvida" (avg_logprob baixo) são mesmo os que ele erra, e sugere o limiar para
  mandar só esses trechos à API (a camada 3 da busca inteligente) e que parte da música iria.
"""
import argparse
import json
import os
import statistics
import subprocess
import sys
import tempfile
import time
from pathlib import Path

from . import consensus
from .storage import LocalStorage
from .textmatch import align_words, containment, normalize_word, same_lyrics, tokens  # noqa: F401 - reexportados: os testes e o relatório os usam

TRUSTED_SOURCES = ("lrclib", "video", "file")  # letra feita por gente, com tempo de linha: serve de gabarito (align/text são da IA ou do usuário sem tempo)
DEFAULT_MODELS = ("base", "small", "medium", "turbo")
BAD_SEGMENT = 0.4  # um trecho com mais de 40% das palavras erradas conta como "ruim"
SIDE_PAD = 0.35  # folga (s) ao pegar as linhas de gabarito que cabem no trecho: o Whisper corta um pouco antes ou depois


# ---------------------------------------------------------------- texto e erro de palavras

def word_errors(ref: list[str], hyp: list[str], pairs: list[tuple[int | None, int | None]] | None = None) -> dict:
    """{"ref_words", "hyp_words", "substitutions", "deletions", "insertions", "errors", "wer"} (wer = None sem palavras no gabarito)."""
    pairs = align_words(ref, hyp) if pairs is None else pairs
    subs = sum(1 for r, h in pairs if r is not None and h is not None and ref[r] != hyp[h])
    dels = sum(1 for r, h in pairs if h is None)
    ins = sum(1 for r, h in pairs if r is None)
    errors = subs + dels + ins
    return {
        "ref_words": len(ref), "hyp_words": len(hyp), "substitutions": subs, "deletions": dels, "insertions": ins,
        "errors": errors, "wer": round(errors / len(ref), 4) if ref else None,
    }


# ---------------------------------------------------------------- gabarito (a letra da biblioteca num trecho)

def reference_window(cues: list[dict], start: float, length: float) -> dict:
    """As linhas da letra de gente que cabem no trecho [start, start+length]: as palavras (com a linha de cada uma) e o tempo de cada linha,
    tudo relativo ao início do trecho."""
    end = start + length
    lines = [c for c in cues if c.get("text") and c["start"] >= start - SIDE_PAD and c["end"] <= end + SIDE_PAD]
    words, line_of = [], []
    for index, cue in enumerate(lines):
        for token in tokens(cue["text"]):
            words.append(token)
            line_of.append(index)
    return {"words": words, "line_of": line_of, "line_starts": [round(c["start"] - start, 3) for c in lines], "lines": len(lines)}


def pick_excerpt(cues: list[dict], length: float, duration: float | None = None) -> tuple[float, float]:
    """Onde cortar: o trecho de `length` segundos que começa na linha que fica a ~25% da letra (o começo tem intro, e o fim, repetição).
    Música mais curta que o trecho usa a música toda."""
    spoken = [c for c in cues if c.get("text")]
    if not spoken:
        return 0.0, length
    first = spoken[len(spoken) // 4]["start"]
    start = max(first - 1.0, 0.0)
    if duration is not None and start + length > duration:
        start = max(duration - length, 0.0)
    return round(start, 2), length


def line_start_errors(window: dict, hyp_starts: list[float], pairs: list[tuple[int | None, int | None]]) -> list[float]:
    """Para cada linha de gabarito, o erro (s) entre o começo dela e o começo da primeira palavra dela que o Whisper acertou ou trocou."""
    first_hit: dict[int, int] = {}
    for r, h in pairs:
        if r is not None and h is not None:
            first_hit.setdefault(window["line_of"][r], h)
    return [round(abs(hyp_starts[h] - window["line_starts"][line]), 3) for line, h in sorted(first_hit.items())]


# ---------------------------------------------------------------- o rascunho contra o catálogo (a camada 2 da busca inteligente)

def catalog_match(heard: dict[str, list[str]], references: dict[str, list[str]]) -> dict | None:
    """Para cada música, o rascunho dela contra a letra dela mesma (par certo) e contra a de todas as outras (pares errados): se um limiar separa
    os dois grupos, o rascunho do áudio escolhe a letra certa do catálogo. Devolve os extremos de cada grupo e o limiar no meio (se houver)."""
    right, wrong = [], []
    for song, hyp in heard.items():
        for other, ref in references.items():
            if other == song:
                right.append(containment(hyp, ref))
            elif not same_lyrics(references[song], ref):  # duas versões da mesma música na biblioteca não são "pares errados"
                wrong.append(containment(hyp, ref))
    if not right or not wrong:
        return None
    gap = min(right) - max(wrong)
    return {"right_min": min(right), "right_median": round(statistics.median(right), 3), "wrong_max": max(wrong),
            "wrong_median": round(statistics.median(wrong), 3), "separable": gap > 0,
            "threshold": round((min(right) + max(wrong)) / 2, 3) if gap > 0 else None, "pairs": {"right": len(right), "wrong": len(wrong)}}


# ---------------------------------------------------------------- confiança x erro

def segment_wrong_fractions(segments: list[dict], pairs: list[tuple[int | None, int | None]], ref: list[str], hyp: list[str]) -> list[dict]:
    """Por trecho que o Whisper escreveu: a confiança dele e a fração das palavras do trecho que estavam erradas (trocadas ou a mais).
    `segments`: [{"first": índice da primeira palavra no hyp, "count": quantas, "avg_logprob": ..., ...}]."""
    wrong = {h for r, h in pairs if h is not None and (r is None or ref[r] != hyp[h])}
    out = []
    for seg in segments:
        indices = range(seg["first"], seg["first"] + seg["count"])
        if not seg["count"]:
            continue
        bad = sum(1 for i in indices if i in wrong)
        out.append({**{k: v for k, v in seg.items() if k not in ("first", "count")}, "words": seg["count"], "wrong": round(bad / seg["count"], 3)})
    return out


CONFIDENCE_KEYS = ("avg_logprob", "mean_word_prob")  # em ambos, quanto MENOR, mais duvidoso


def suggest_threshold(samples: list[dict], key: str = "avg_logprob", bad: float = BAD_SEGMENT) -> dict | None:
    """O limiar de confiança para a camada 3 (mandar à API só os trechos duvidosos): entre os cortes possíveis, o que melhor separa os trechos
    ruins (palavras erradas >= `bad`). Devolve o corte, quanto dos trechos ruins ele pega (recall), quanto dos marcados são de fato ruins
    (precisão) e que parte das palavras iria à API (o custo)."""
    usable = [s for s in samples if s.get(key) is not None]
    total_words = sum(s["words"] for s in usable)
    bad_total = sum(1 for s in usable if s["wrong"] >= bad)
    if not usable or not bad_total or not total_words:
        return None
    best = None
    for cut in sorted({s[key] for s in usable}):
        flagged = [s for s in usable if s[key] <= cut]
        hit = sum(1 for s in flagged if s["wrong"] >= bad)
        precision, recall = hit / len(flagged), hit / bad_total
        f1 = 0 if not (precision + recall) else 2 * precision * recall / (precision + recall)
        if best is None or f1 > best["f1"]:
            best = {"cut": round(cut, 3), "f1": round(f1, 3), "precision": round(precision, 3), "recall": round(recall, 3),
                    "api_share_of_words": round(sum(s["words"] for s in flagged) / total_words, 3)}
    return best


# ---------------------------------------------------------------- a biblioteca e o Whisper

def eligible_songs(storage: LocalStorage, only: set[str] | None = None) -> list[dict]:
    """As músicas da biblioteca que servem de gabarito: voz isolada + letra de gente com o tempo de cada linha (fonte exatamente lrclib,
    video ou file; "lrclib+align", "align" e "text" ficam de fora porque o tempo ou o texto não são de gente)."""
    from .pipeline import keys

    songs = []
    root = storage.root / "cache"
    for folder in sorted(root.iterdir()) if root.is_dir() else []:
        video_id = folder.name
        if only and video_id not in only:
            continue
        k = keys(video_id)
        if not all(storage.exists(k[name]) for name in ("vocals", "lyrics", "meta")):
            continue
        meta = json.loads(storage.read(k["meta"]))
        if meta.get("lyrics_source") not in TRUSTED_SOURCES:
            continue
        cues = json.loads(storage.read(k["lyrics"]))
        if len([c for c in cues if c.get("text")]) < 6:
            continue
        songs.append({"id": video_id, "title": meta.get("title") or video_id, "artist": meta.get("artist"), "duration": meta.get("duration"),
                      "source": meta.get("lyrics_source"), "cues": cues, "vocals": storage.root / k["vocals"]})
    return songs


def cut_excerpt(audio: Path, start: float, length: float, out: Path) -> Path:
    """O trecho da voz isolada em WAV mono de 16 kHz (o que o Whisper usa): o corte é feito uma vez e serve a todos os modelos."""
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-ss", str(start), "-t", str(length), "-i", str(audio), "-ac", "1", "-ar", "16000", str(out)], check=True)
    return out


def transcribe(model, wav: Path) -> dict:
    """Roda o Whisper (stable-ts) no trecho: as palavras, com o começo e a probabilidade de cada uma, e os trechos com a confiança deles."""
    result = model.transcribe(str(wav), word_timestamps=True, verbose=None)
    words, segments = [], []
    for seg in result.segments:
        first = len(words)
        for w in seg.words or []:
            token = normalize_word(w.word)
            if token:
                words.append({"token": token, "text": str(w.word).strip(), "start": float(w.start), "prob": float(getattr(w, "probability", 0.0) or 0.0)})
        probs = [x["prob"] for x in words[first:]]
        segments.append({
            "first": first, "count": len(words) - first,
            "avg_logprob": getattr(seg, "avg_logprob", None), "no_speech_prob": getattr(seg, "no_speech_prob", None),
            "compression_ratio": getattr(seg, "compression_ratio", None), "mean_word_prob": round(sum(probs) / len(probs), 3) if probs else None,
        })
    return {"words": words, "segments": segments, "language": getattr(result, "language", None)}


def score_song(window: dict, heard: dict) -> dict:
    """Compara a letra de gabarito do trecho com o que o Whisper ouviu."""
    ref, hyp = window["words"], [w["token"] for w in heard["words"]]
    pairs = align_words(ref, hyp)
    result = word_errors(ref, hyp, pairs)
    errors = line_start_errors(window, [w["start"] for w in heard["words"]], pairs)
    result["line_start_errors"] = errors
    result["segments"] = segment_wrong_fractions(heard["segments"], pairs, ref, hyp)
    result["language"] = heard.get("language")
    return result


def summarize(songs: list[dict]) -> dict:
    """Os números de um modelo sobre um conjunto de músicas: WER (mediano e das palavras todas juntas), erro de início de linha, tempo."""
    scored = [s for s in songs if s.get("wer") is not None]
    if not scored:
        return {"songs": 0}
    ref_total = sum(s["ref_words"] for s in scored)
    errors_total = sum(s["errors"] for s in scored)
    starts = [e for s in scored for e in s["line_start_errors"]]
    audio = sum(s["audio_seconds"] for s in scored)
    spent = sum(s["seconds"] for s in scored)
    return {
        "songs": len(scored), "wer_median": round(statistics.median(s["wer"] for s in scored), 3), "wer_pooled": round(errors_total / ref_total, 3),
        "line_start_median_s": round(statistics.median(starts), 2) if starts else None,
        "line_start_within_1s": round(sum(1 for e in starts if e <= 1.0) / len(starts), 3) if starts else None,
        "realtime_factor": round(spent / audio, 3) if audio else None, "seconds_per_song": round(spent / len(scored), 1),
    }


def recommend(summaries: dict[str, dict], tolerance: float = 0.03) -> dict | None:
    """O modelo padrão sugerido: o MAIS RÁPIDO cujo WER fica a no máximo `tolerance` do melhor WER medido."""
    ok = {name: s for name, s in summaries.items() if s.get("songs")}
    if not ok:
        return None
    best = min(s["wer_pooled"] for s in ok.values())
    close = {name: s for name, s in ok.items() if s["wer_pooled"] <= best + tolerance}
    name = min(close, key=lambda n: close[n]["realtime_factor"] if close[n]["realtime_factor"] is not None else 9e9)
    return {"model": name, "wer_pooled": ok[name]["wer_pooled"], "realtime_factor": ok[name]["realtime_factor"], "best_wer": best, "tolerance": tolerance}


def render_table(report: dict) -> str:
    """O relatório em tabela de texto (o JSON tem o resto)."""
    lines = [f"{'modelo':<8} {'grupo':<8} {'músicas':>7} {'WER':>6} {'WER med.':>8} {'início med.':>11} {'<=1 s':>6} {'x tempo real':>12}"]
    for model, groups in report["models"].items():
        for group, s in groups.items():
            if not s.get("songs"):
                continue
            share = '-' if s["line_start_within_1s"] is None else f"{s['line_start_within_1s']:.0%}"
            lines.append(f"{model:<8} {group:<8} {s['songs']:>7} {s['wer_pooled']:>6.1%} {s['wer_median']:>8.1%} "
                         f"{(str(s['line_start_median_s']) + ' s') if s['line_start_median_s'] is not None else '-':>11} {share:>6} {s['realtime_factor']:>12}")
    for combo, data in report.get("votes", {}).items():
        v = data["summary"]
        shift = ", ".join(f"{m} {d:+.1%}" for m, d in v["vs_single"].items())
        lines.append(f"voto {combo:<22} todas {v['songs']:>3} músicas  WER {v['wer_pooled']:.1%}  mediano {v['wer_median']:.1%}  início med. {v['line_start_median_s']} s"
                     f"  (contra cada modelo sozinho: {shift}; o voto mexeu em {v['vote_changes']} palavras)")
    rec = report.get("recommendation")
    if rec:
        lines.append(f"\nModelo padrão sugerido: {rec['model']} (WER {rec['wer_pooled']:.1%}, melhor medido {rec['best_wer']:.1%}, {rec['realtime_factor']}x o tempo da música)")
    for model, found in report.get("thresholds", {}).items():
        for key, cut in found.get("signals", {}).items():
            if cut:
                mark = " (melhor sinal)" if key == found.get("best") else ""
                lines.append(f"Limiar da API ({model}, {key}{mark}): <= {cut['cut']} pega {cut['recall']:.0%} dos trechos ruins, {cut['precision']:.0%} do que marca é ruim mesmo, "
                             f"e mandaria {cut['api_share_of_words']:.0%} das palavras à API")
    for model, match in report.get("catalog_match", {}).items():
        if match:
            verdict = f"limiar {match['threshold']}" if match["separable"] else "NÃO separa"
            lines.append(f"Escolher a letra do catálogo pelo áudio ({model}): par certo >= {match['right_min']} (mediana {match['right_median']}), "
                         f"pares errados <= {match['wrong_max']} (mediana {match['wrong_median']}): {verdict}")
    return "\n".join(lines)


def vote_report(prepared: list[dict], heard_by_model: dict[str, dict[str, dict]], combos: list[list[str]], singles: dict[str, dict]) -> dict:
    """Mede o voto: para cada combinação de modelos (a primeira é o pivô), junta o que eles ouviram em cada música com `consensus.vote` e
    compara com a letra de gabarito, igual ao que se faz com um modelo só. `singles` são os resumos dos modelos sozinhos, para comparar."""
    report = {}
    for combo in combos:
        per_song = []
        for song in prepared:
            sources = [{"name": m, "words": heard_by_model[m][song["id"]]["words"]} for m in combo if song["id"] in heard_by_model.get(m, {})]
            if len(sources) < len(combo):
                continue
            voted = consensus.vote(sources)
            heard = {"words": voted["words"], "segments": [], "language": None}
            scored = score_song(song["window"], heard)
            per_song.append({**scored, "id": song["id"], "group": song["group"], "seconds": 0.0, "audio_seconds": song["length"], "vote": voted["stats"]})
        if not per_song:
            continue
        summary = summarize(per_song)
        summary["vote_changes"] = sum(s["vote"]["changed"] + s["vote"]["removed"] + s["vote"]["added"] for s in per_song)
        summary["vs_single"] = {m: round(summary["wer_pooled"] - singles[m]["wer_pooled"], 3) for m in combo if singles.get(m, {}).get("songs")}
        report["+".join(combo)] = {"summary": summary, "per_song": [{k: v for k, v in s.items() if k != "segments"} for s in per_song]}
    return report


def best_signal(samples: list[dict]) -> dict:
    """Testa cada sinal de confiança e devolve todos, com o melhor (maior F1) marcado: o que mais separa o trecho ruim do bom."""
    found = {key: suggest_threshold(samples, key) for key in CONFIDENCE_KEYS}
    ranked = [(cut["f1"], key) for key, cut in found.items() if cut]
    return {"signals": found, "best": max(ranked)[1] if ranked else None}


def run(storage_root: str, models: list[str], excerpt: float, covers: set[str], only: set[str] | None, limit: int | None, device: str | None,
        out: Path | None, log=print, votes: list[list[str]] | None = None) -> dict:
    import stable_whisper  # import tardio: só quem mede precisa do Whisper

    storage = LocalStorage(storage_root)
    songs = eligible_songs(storage, only)
    if limit:
        songs = songs[:limit]
    if not songs:
        raise SystemExit("Nenhuma música da biblioteca serve de gabarito (precisa de voz isolada e de letra da LRCLIB ou da legenda do vídeo).")
    log(f"{len(songs)} música(s) de gabarito; trecho de {excerpt:g} s; modelos: {', '.join(models)}")
    report: dict = {"excerpt_seconds": excerpt, "device": device or "auto", "models": {}, "songs": [], "thresholds": {}}
    work = Path(tempfile.mkdtemp(prefix="singalong-bench-"))
    prepared = []
    for song in songs:
        start, length = pick_excerpt(song["cues"], excerpt, song.get("duration"))
        window = reference_window(song["cues"], start, length)
        if len(window["words"]) < 8:
            log(f"  {song['id']}: poucas palavras no trecho, ignorada")
            continue
        wav = cut_excerpt(Path(song["vocals"]), start, length, work / f"{song['id']}.wav")
        prepared.append({**song, "start": start, "length": length, "window": window, "wav": wav, "group": "cover" if song["id"] in covers else "original"})
        report["songs"].append({"id": song["id"], "title": song["title"], "artist": song["artist"], "source": song["source"], "excerpt_start": start,
                                "ref_words": len(window["words"]), "group": prepared[-1]["group"]})
    heard_by_model: dict[str, dict[str, dict]] = {}
    for name in models:
        log(f"\nmodelo {name}: carregando…")
        model = stable_whisper.load_model(name, device=device, download_root=os.environ.get("WHISPER_CACHE") or None)  # o mesmo cache do alinhamento
        per_song = []
        hypotheses: dict[str, list[str]] = {}
        for song in prepared:
            t0 = time.monotonic()
            try:
                heard = transcribe(model, song["wav"])
            except Exception as exc:  # noqa: BLE001 - um áudio ruim não derruba a medição inteira
                log(f"  {song['id']}: falhou ({exc})")
                continue
            seconds = time.monotonic() - t0
            scored = score_song(song["window"], heard)
            hypotheses[song["id"]] = [w["token"] for w in heard["words"]]
            heard_by_model.setdefault(name, {})[song["id"]] = heard
            per_song.append({**scored, "id": song["id"], "group": song["group"], "seconds": round(seconds, 1), "audio_seconds": song["length"]})
            log(f"  {song['id']}: WER {scored['wer']:.1%} em {seconds:.1f} s")
        groups = {"todas": summarize(per_song), "original": summarize([s for s in per_song if s["group"] == "original"]),
                  "cover": summarize([s for s in per_song if s["group"] == "cover"])}
        report["models"][name] = groups
        report["thresholds"][name] = best_signal([seg for s in per_song for seg in s["segments"]])
        report.setdefault("catalog_match", {})[name] = catalog_match(hypotheses, {s["id"]: [t for c in s["cues"] if c.get("text") for t in tokens(c["text"])] for s in prepared})
        report.setdefault("per_song", {})[name] = per_song  # com os trechos (só números, sem texto) para reanalisar sem rodar tudo de novo
        del model
    report["recommendation"] = recommend({name: groups["todas"] for name, groups in report["models"].items()})
    if votes:
        report["votes"] = vote_report(prepared, heard_by_model, votes, {name: groups["todas"] for name, groups in report["models"].items()})
    log("\n" + render_table(report))
    if out:
        out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        log(f"\nRelatório completo: {out}")
    return report


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0], formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--storage-root", required=True, help="a biblioteca (a pasta que tem cache/)")
    p.add_argument("--models", default=",".join(DEFAULT_MODELS), help="modelos do Whisper separados por vírgula (padrão: %(default)s)")
    p.add_argument("--excerpt", type=float, default=90.0, help="segundos de cada música a transcrever (padrão: %(default)s; a música toda custa muito na CPU)")
    p.add_argument("--covers", type=Path, help="arquivo com os IDs (um por linha) das músicas que são covers: o relatório as separa")
    p.add_argument("--only", help="só estes IDs, separados por vírgula")
    p.add_argument("--limit", type=int, help="no máximo N músicas")
    p.add_argument("--device", choices=["cpu", "cuda"], help="padrão: automático")
    p.add_argument("--out", type=Path, default=Path("bench-transcribe.json"), help="onde gravar o relatório (padrão: %(default)s)")
    p.add_argument("--vote", help="combinações de modelos para votar, separadas por vírgula; em cada uma os modelos se separam por + e o primeiro é o pivô "
                   "(ex.: medium+turbo+small,medium+turbo). Os modelos precisam estar em --models")
    p.add_argument("--list", action="store_true", help="só lista as músicas que servem de gabarito")
    args = p.parse_args(sys.argv[1:] if argv is None else argv)
    only = set(args.only.split(",")) if args.only else None
    if args.list:
        for song in eligible_songs(LocalStorage(args.storage_root), only):
            print(f"{song['id']}  {song['source']:<10} {len([c for c in song['cues'] if c.get('text')]):>3} linhas  {song['artist'] or ''} - {song['title']}")
        return 0
    covers = {line.strip() for line in args.covers.read_text(encoding="utf-8").splitlines() if line.strip()} if args.covers else set()
    models = [m.strip() for m in args.models.split(",") if m.strip()]
    votes = [[m.strip() for m in combo.split("+") if m.strip()] for combo in args.vote.split(",")] if args.vote else None
    for combo in votes or []:
        if not set(combo) <= set(models):
            raise SystemExit(f"--vote usa modelos que não estão em --models: {', '.join(sorted(set(combo) - set(models)))}")
    run(args.storage_root, models, args.excerpt, covers, only, args.limit, args.device, args.out, votes=votes)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
