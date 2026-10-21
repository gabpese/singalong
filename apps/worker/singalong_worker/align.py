"""Forced alignment: finds WHEN each line of the user's lyrics is sung, from the isolated vocals.

It transcribes nothing and writes no lyrics: the user gives the text, and the model (Whisper, via stable-ts) only times it.
"""
import os
from pathlib import Path

DEFAULT_MODEL = "small"  # a balance between accuracy and size (~460 MB); ALIGN_MODEL=base|small|medium
MIN_LINE_SECONDS = 0.3

_models: dict = {}


def clean_lines(text: str) -> list[str]:
    """One entry per verse. Skips blank lines and section markers such as "[Chorus]" (they are not sung)."""
    lines = (line.strip() for line in text.splitlines())
    return [line for line in lines if line and not (line.startswith("[") and line.endswith("]"))]


def detect_language(text: str, default: str = "en") -> str:
    """The LYRICS' language (not the audio's), as the 2-letter code Whisper uses."""
    try:
        from langdetect import DetectorFactory, detect

        DetectorFactory.seed = 0  # a deterministic result
        code = detect(text)
    except Exception:  # noqa: BLE001 - texto curto/sem letras: cai no padrão
        return default
    return {"zh-cn": "zh", "zh-tw": "zh"}.get(code, code)


def _word_times(chunk: list, line_start: float, line_end: float) -> list[list[float]]:
    """[[start, end], ...] of each word of the line, without leaving the line, going back in time or leaving negative gaps."""
    out, prev_end = [], line_start
    for w in chunk:
        s = min(max(float(w.start), prev_end), line_end)
        e = min(max(float(w.end), s), line_end)
        out.append([round(s, 2), round(e, 2)])
        prev_end = e
    return out


def group_words(lines: list[str], words: list) -> list[dict]:
    """Groups the aligned words (with .start/.end) into the lines, by each line's word count.

    The alignment runs on the user's text, so the word count matches; if it does not, the
    result would be a guess and we would rather fail.
    """
    counts = [len(line.split()) for line in lines]
    if sum(counts) != len(words):
        raise ValueError(
            f"Não consegui sincronizar a letra: {sum(counts)} palavras no texto, {len(words)} alinhadas. "
            "Confira se a letra está completa e no mesmo idioma da música."
        )
    cues, i, last_start = [], 0, 0.0
    for line, n in zip(lines, counts):
        chunk = words[i : i + n]
        i += n
        start = max(float(chunk[0].start), last_start)  # never goes back in time
        end = max(float(chunk[-1].end), start + MIN_LINE_SECONDS)
        cues.append({"start": round(start, 2), "end": round(end, 2), "text": line, "words": _word_times(chunk, start, end)})
        last_start = start
    return cues


def attach_words(cues: list[dict], aligned: list[dict], tolerance: float = 2.5) -> tuple[list[dict], int]:
    """Copies the per-word timings from `aligned` into `cues` (lyrics already synced by line, e.g. LRCLIB).

    The LINES' timings do not change. Lines where the AI disagrees with the original by more than `tolerance` seconds
    (or with a different word count) get no `words`: the player estimates the fill. Returns (cues, lines with words).
    """
    if len(cues) != len(aligned):
        return cues, 0
    out, done = [], 0
    for cue, ref in zip(cues, aligned):
        words = ref.get("words")
        if words and len(words) == len(cue["text"].split()) and abs(ref["start"] - cue["start"]) <= tolerance:
            lo, hi = cue["start"], max(cue["end"], cue["start"])
            words = [[round(min(max(s, lo), hi), 2), round(min(max(e, lo), hi), 2)] for s, e in words]
            out.append({**cue, "words": words})
            done += 1
        else:
            out.append({k: v for k, v in cue.items() if k != "words"})
    return out, done


def _load_model(name: str, device: str | None):
    key = (name, device)
    if key not in _models:
        import stable_whisper

        root = os.environ.get("WHISPER_CACHE") or str(Path(os.environ.get("TORCH_HOME", "~/.cache/torch")).expanduser() / "whisper")
        _models[key] = stable_whisper.load_model(name, device=device, download_root=root)
    return _models[key]


def align_lyrics(audio: Path, text: str, language: str | None = None, device: str | None = None) -> list[dict]:
    """[{start, end, text}] per line, aligning `text` to the audio (preferably the vocals alone)."""
    lines = clean_lines(text)
    if not lines:
        raise ValueError("Cole a letra no campo de texto.")
    model = _load_model(os.environ.get("ALIGN_MODEL", DEFAULT_MODEL), device)
    result = model.align(str(audio), "\n".join(lines), language=language or detect_language(text))
    return group_words(lines, result.all_words())
