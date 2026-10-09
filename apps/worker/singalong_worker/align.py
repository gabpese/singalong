"""Alinhamento forçado: descobre QUANDO cada linha da letra do usuário é cantada, a partir da voz isolada.

Não transcreve nem gera letra: o texto vem do usuário e o modelo (Whisper, via stable-ts) só marca os tempos.
"""
import os
from pathlib import Path

DEFAULT_MODEL = "small"  # equilíbrio entre precisão e tamanho (~460 MB); ALIGN_MODEL=base|small|medium
MIN_LINE_SECONDS = 0.3

_models: dict = {}


def clean_lines(text: str) -> list[str]:
    """Uma entrada por verso. Ignora linhas em branco e indicações de seção como "[Chorus]" (não são cantadas)."""
    lines = (line.strip() for line in text.splitlines())
    return [line for line in lines if line and not (line.startswith("[") and line.endswith("]"))]


def detect_language(text: str, default: str = "en") -> str:
    """Idioma da LETRA (não do áudio), no código de 2 letras que o Whisper usa."""
    try:
        from langdetect import DetectorFactory, detect

        DetectorFactory.seed = 0  # resultado determinístico
        code = detect(text)
    except Exception:  # noqa: BLE001 - texto curto/sem letras: cai no padrão
        return default
    return {"zh-cn": "zh", "zh-tw": "zh"}.get(code, code)


def group_words(lines: list[str], words: list) -> list[dict]:
    """Agrupa as palavras alinhadas (com .start/.end) nas linhas, pela contagem de palavras de cada linha.

    O alinhamento é feito sobre o texto do usuário, então a contagem de palavras bate; se não bater, o
    resultado seria um chute e preferimos falhar.
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
        start = max(float(chunk[0].start), last_start)  # nunca volta no tempo
        end = max(float(chunk[-1].end), start + MIN_LINE_SECONDS)
        cues.append({"start": round(start, 2), "end": round(end, 2), "text": line})
        last_start = start
    return cues


def _load_model(name: str, device: str | None):
    key = (name, device)
    if key not in _models:
        import stable_whisper

        root = os.environ.get("WHISPER_CACHE") or str(Path(os.environ.get("TORCH_HOME", "~/.cache/torch")).expanduser() / "whisper")
        _models[key] = stable_whisper.load_model(name, device=device, download_root=root)
    return _models[key]


def align_lyrics(audio: Path, text: str, language: str | None = None, device: str | None = None) -> list[dict]:
    """[{start, end, text}] por linha, alinhando `text` ao áudio (de preferência só a voz)."""
    lines = clean_lines(text)
    if not lines:
        raise ValueError("Cole a letra no campo de texto.")
    model = _load_model(os.environ.get("ALIGN_MODEL", DEFAULT_MODEL), device)
    result = model.align(str(audio), "\n".join(lines), language=language or detect_language(text))
    return group_words(lines, result.all_words())
