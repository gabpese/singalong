"""The original voice's melody (a MIDI note every 50 ms), for scoring through the microphone."""
import math
from pathlib import Path

HOP_SECONDS = 0.05
SAMPLE_RATE = 16000
MIN_RUN = 2  # "sung" stretches shorter than this (2 frames = 100 ms) are the detector's noise


ENERGY_FLOOR = 0.12  # frames with less than 12% of the energy of the loudest stretches are Demucs leakage, not singing
SPAN_MARGIN = 0.25  # slack (s) around each lyrics line


def lyric_spans(cues: list[dict] | None) -> list[tuple[float, float]] | None:
    """The intervals in which someone sings, from the synced lyrics (None = no lyrics: they cannot filter anything)."""
    if not cues:
        return None
    return [(float(c["start"]) - SPAN_MARGIN, float(c["end"]) + SPAN_MARGIN) for c in cues]


def melody_from_f0(
    f0: list[float | None],
    energy: list[float] | None = None,
    spans: list[tuple[float, float]] | None = None,
) -> dict:
    """{hop, midi}: the integer MIDI note of each frame, or -1 when there is no voice.

    No voice = f0 missing/NaN/<=0, low energy (`energy`, the instrumental leaking into the isolated vocals) or outside the
    lyrics' lines (`spans`): nobody sings in those pauses, so the singer cannot be scored on them.
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
    while i < len(midi):  # drops voice stretches that are too short
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
    """Estimates the isolated vocals' pitch (pYIN), dropping leakage and stretches outside the lyrics. One value per 50 ms."""
    import librosa  # imported here: it is heavy and only the worker needs it

    y, sr = librosa.load(str(vocals), sr=SAMPLE_RATE, mono=True)
    hop = int(sr * HOP_SECONDS)
    f0, _, _ = librosa.pyin(
        y, fmin=librosa.note_to_hz("C2"), fmax=librosa.note_to_hz("C6"), sr=sr, frame_length=1024, hop_length=hop,
    )
    energy = librosa.feature.rms(y=y, frame_length=1024, hop_length=hop)[0]
    return melody_from_f0(
        [None if not math.isfinite(f) else float(f) for f in f0], [float(e) for e in energy], lyric_spans(cues),
    )
