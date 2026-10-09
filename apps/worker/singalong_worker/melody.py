"""Melodia da voz original (nota MIDI a cada 50 ms), para a pontuação pelo microfone."""
import math
from pathlib import Path

HOP_SECONDS = 0.05
SAMPLE_RATE = 16000
MIN_RUN = 2  # trechos "cantados" mais curtos que isso (2 quadros = 100 ms) são ruído do detector


def melody_from_f0(f0: list[float]) -> dict:
    """{hop, midi}: nota MIDI inteira de cada quadro, ou -1 quando não há voz (f0 ausente/NaN/<=0)."""
    midi = [-1 if (f is None or not math.isfinite(f) or f <= 0) else round(69 + 12 * math.log2(f / 440.0)) for f in f0]
    i = 0
    while i < len(midi):  # descarta trechos de voz curtos demais
        if midi[i] == -1:
            i += 1
            continue
        j = i
        while j < len(midi) and midi[j] != -1:
            j += 1
        if j - i < MIN_RUN:
            midi[i:j] = [-1] * (j - i)
        i = j
    return {"hop": HOP_SECONDS, "midi": midi}


def extract_melody(vocals: Path) -> dict:
    """Estima o tom da voz isolada (pYIN). Devolve {hop, midi} com um valor por 50 ms."""
    import librosa  # importado aqui: é pesado e só o worker precisa

    y, sr = librosa.load(str(vocals), sr=SAMPLE_RATE, mono=True)
    f0, _, _ = librosa.pyin(
        y, fmin=librosa.note_to_hz("C2"), fmax=librosa.note_to_hz("C6"), sr=sr,
        frame_length=1024, hop_length=int(sr * HOP_SECONDS),
    )
    return melody_from_f0([None if not math.isfinite(f) else float(f) for f in f0])
