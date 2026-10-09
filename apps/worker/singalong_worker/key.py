"""Tom (tonalidade) da música.

Método clássico: o perfil de notas (croma) do instrumental é comparado com os 24 perfis de tonalidade
(12 maiores + 12 menores) de Krumhansl-Kessler; vence a maior correlação. É uma ESTIMATIVA: tonalidades relativas
(Dó maior / Lá menor) usam as mesmas notas e podem ser confundidas, por isso devolvemos também a alternativa e a margem.
"""
import logging
import math

log = logging.getLogger("worker.key")

NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# Perfis de Krumhansl-Kessler: quão "estável" é cada grau da escala (índice 0 = tônica)
MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]


def _pearson(a: list[float], b: list[float]) -> float:
    mean_a, mean_b = sum(a) / len(a), sum(b) / len(b)
    da = [x - mean_a for x in a]
    db = [x - mean_b for x in b]
    denom = math.sqrt(sum(x * x for x in da) * sum(x * x for x in db))
    return sum(x * y for x, y in zip(da, db)) / denom if denom else 0.0


def best_key(chroma: list[float]) -> dict:
    """Tonalidade mais provável para um perfil de croma de 12 valores (índice 0 = Dó).

    Devolve {tonic (0..11), mode ('major'|'minor'), name, score, margin, alt}:
    score = correlação da melhor tonalidade; margin = vantagem sobre a segunda; alt = a segunda colocada.
    """
    if len(chroma) != 12 or not any(chroma):
        raise ValueError("o perfil de croma precisa ter 12 valores e não ser vazio")
    scores = []
    for tonic in range(12):
        rotated = chroma[tonic:] + chroma[:tonic]  # a nota candidata a tônica vai para o índice 0
        scores.append((_pearson(rotated, MAJOR_PROFILE), tonic, "major"))
        scores.append((_pearson(rotated, MINOR_PROFILE), tonic, "minor"))
    scores.sort(reverse=True)
    (best, tonic, mode), (second, alt_tonic, alt_mode) = scores[0], scores[1]
    return {
        "tonic": tonic,
        "mode": mode,
        "name": NOTES[tonic],
        "score": round(best, 3),
        "margin": round(best - second, 3),
        "alt": {"tonic": alt_tonic, "mode": alt_mode, "name": NOTES[alt_tonic]},
    }


def chroma_profile(path, seconds: int = 240) -> list[float]:
    """Perfil de croma médio do áudio (12 valores), com a afinação do arquivo compensada."""
    import librosa  # import tardio: a parte matemática acima não precisa dele

    y, sr = librosa.load(str(path), sr=22050, mono=True, duration=seconds)
    y = librosa.effects.harmonic(y, margin=4)  # tira percussão e ruído, que borram o croma
    tuning = librosa.estimate_tuning(y=y, sr=sr)  # gravações levemente fora de A=440 Hz
    chroma = librosa.feature.chroma_cqt(y=y, sr=sr, tuning=tuning)
    return [float(v) for v in chroma.mean(axis=1)]


def detect_key(path) -> dict:
    return best_key(chroma_profile(path))


def backfill(storage) -> int:
    """Calcula o tom das músicas já no cache que ainda não têm (processadas antes deste recurso)."""
    import json
    import tempfile
    from pathlib import Path

    from .meta_store import update_meta

    done = 0
    for meta_key in [k for k in storage.list("cache") if k.endswith("/meta.json")]:
        base = meta_key.rsplit("/", 1)[0]
        try:
            meta = json.loads(storage.read(meta_key))
            if meta.get("key") or not storage.exists(f"{base}/instrumental.mp3"):
                continue
            with tempfile.TemporaryDirectory(prefix="singalong-key-") as tmp:
                audio = Path(tmp) / "instrumental.mp3"
                audio.write_bytes(storage.read(f"{base}/instrumental.mp3"))
                key = detect_key(audio)  # a parte demorada fica fora da trava do meta.json
            update_meta(storage, base.split("/")[1], lambda m: m.setdefault("key", key))
            done += 1
            log.info("tom de %s: %s %s", base, key["name"], key["mode"])
        except Exception as exc:  # noqa: BLE001 - uma música com problema não impede as outras
            log.warning("não consegui calcular o tom de %s: %s", base, exc)
    return done
