"""Melodia da voz original (nota MIDI a cada 50 ms), para a pontuação pelo microfone."""
import math
from pathlib import Path

HOP_SECONDS = 0.05
SAMPLE_RATE = 16000
MIN_RUN = 2  # trechos "cantados" mais curtos que isso (2 quadros = 100 ms) são ruído do detector


ENERGY_FLOOR = 0.12  # quadros com menos de 12% da energia dos trechos mais fortes são vazamento do Demucs, não canto
SPAN_MARGIN = 0.25  # folga (s) ao redor de cada linha da letra


def lyric_spans(cues: list[dict] | None) -> list[tuple[float, float]] | None:
    """Intervalos em que alguém canta, segundo a letra sincronizada (None = sem letra: não dá para filtrar por ela)."""
    if not cues:
        return None
    return [(float(c["start"]) - SPAN_MARGIN, float(c["end"]) + SPAN_MARGIN) for c in cues]


def melody_from_f0(
    f0: list[float | None],
    energy: list[float] | None = None,
    spans: list[tuple[float, float]] | None = None,
) -> dict:
    """{hop, midi}: nota MIDI inteira de cada quadro, ou -1 quando não há voz.

    Sem voz = f0 ausente/NaN/<=0, energia baixa (`energy`, vazamento do instrumental na voz isolada) ou fora das linhas
    da letra (`spans`): nessas pausas ninguém canta, então o cantor não pode ser cobrado.
    """
    midi = []
    loud = None
    if energy:
        ordered = sorted(energy)
        loud = ordered[int(0.95 * (len(ordered) - 1))] * ENERGY_FLOOR
    for i, f in enumerate(f0):
        t = i * HOP_SECONDS
        silent = f is None or not math.isfinite(f) or f <= 0
        if not silent and loud is not None and i < len(energy) and energy[i] < loud:
            silent = True
        if not silent and spans is not None and not any(a <= t <= b for a, b in spans):
            silent = True
        midi.append(-1 if silent else round(69 + 12 * math.log2(f / 440.0)))
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


def extract_melody(vocals: Path, cues: list[dict] | None = None) -> dict:
    """Estima o tom da voz isolada (pYIN), descartando vazamento e trechos fora da letra. Um valor por 50 ms."""
    import librosa  # importado aqui: é pesado e só o worker precisa

    y, sr = librosa.load(str(vocals), sr=SAMPLE_RATE, mono=True)
    hop = int(sr * HOP_SECONDS)
    f0, _, _ = librosa.pyin(
        y, fmin=librosa.note_to_hz("C2"), fmax=librosa.note_to_hz("C6"), sr=sr, frame_length=1024, hop_length=hop,
    )
    energy = librosa.feature.rms(y=y, frame_length=1024, hop_length=hop)[0]
    return melody_from_f0(
        [None if not math.isfinite(f) else float(f) for f in f0], [float(e) for e in energy], lyric_spans(cues),
    )
