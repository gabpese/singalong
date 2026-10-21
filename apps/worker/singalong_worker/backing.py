"""Backing vocals separated from the lead vocals, for the backing vocals' level control.

Demucs delivers only "vocals" and "instrumental", and the vocals mix the lead with the backing. A second pass, with a UVR
"karaoke" model (MDX-Net), splits the isolated vocals into lead and backing; the backing becomes `cache/<id>/backing.mp3`.
The TV plays instrumental + backing at the volume set by whoever picked the song.

It does not hold the song back: the song becomes ready without the backing, and a thread of its own makes it later (it
takes minutes on a CPU). Songs without real backing (a single voice) are marked `backing.status = "none"` and get no file.

The request (the video_id of a song that just became ready) comes from the worker itself, through the backend (backend.py):
a Redis list in the classic worker, an in-memory queue in the local agent.
meta.json: `backing: {"status": "ready" | "none", "share": 0..1}`.
"""
import json
import logging
import os
import subprocess
import tempfile
import threading
from collections import deque
from pathlib import Path

from .meta_store import meta_key, update_meta

log = logging.getLogger("worker.backing")

MODEL ="UVR_MDXNET_KARA_2.onnx"
MODEL_DIR = os.environ.get("BACKING_MODEL_DIR", "/models/audio-separator")
SAMPLE_RATE = 22050
FRAME = 2048
# the backing counts if, in at least 5% of the stretches with lead vocals, it comes within -15 dB of them (0.178 in amplitude)
CLOSE_RATIO = 0.178
MIN_SHARE = 0.05
BITRATE = "128k"
FFMPEG_TIMEOUT = 300

_separator = None  # the model loads only once (it takes a few seconds and downloads the first time)


def backing_key(video_id: str) -> str:
    return f"cache/{video_id}/backing.mp3"


def backing_share(lead, back) -> float:
    """The share of the lead vocals' stretches where the backing comes close to them (≥ -15 dB). 0 = a single voice."""
    import numpy as np

    def rms(y):
        frames = len(y) // FRAME
        return np.sqrt((np.asarray(y[: frames * FRAME], dtype=float).reshape(frames, FRAME) ** 2).mean(axis=1)) if frames else np.zeros(0)

    lead_rms, back_rms = rms(lead), rms(back)
    n = min(len(lead_rms), len(back_rms))
    lead_rms, back_rms = lead_rms[:n], back_rms[:n]
    if not n:
        return 0.0
    active = lead_rms > np.percentile(lead_rms, 50) * 0.3  # where the lead vocals sing
    if not active.any():
        return 0.0
    return float(np.mean(back_rms[active] > lead_rms[active] * CLOSE_RATIO))


def is_usable(share: float) -> bool:
    return share >= MIN_SHARE


def _load_separator(work: Path):
    global _separator
    from audio_separator.separator import Separator  # heavy: only the worker needs it

    if _separator is None:
        _separator = Separator(output_dir=str(work), output_format="WAV", model_file_dir=MODEL_DIR, log_level=30)
        _separator.load_model(model_filename=MODEL)
    _separator.output_dir = str(work)
    return _separator


def separate_vocals(vocals: Path, work: Path) -> tuple[Path, Path]:
    """(lead vocals, backing vocals) as WAV. The model calls the lead "Vocals" and the backing "Instrumental"."""
    names = _load_separator(work).separate(str(vocals))
    paths = [Path(n) if Path(n).is_absolute() else work / n for n in names]
    lead = next(p for p in paths if "(Vocals)" in p.name)
    back = next(p for p in paths if "(Instrumental)" in p.name)
    return lead, back


def _load_mono(path: Path):
    import librosa

    y, _ = librosa.load(str(path), sr=SAMPLE_RATE, mono=True)
    return y


def process(storage, video_id: str) -> str:
    """Separates the backing vocals of a ready song. Returns "ready" or "none" (and writes it to meta.json)."""
    vocals_key = f"cache/{video_id}/vocals.mp3"
    if not (storage.exists(meta_key(video_id)) and storage.exists(vocals_key)):
        raise FileNotFoundError("a música não está pronta ou não tem a voz isolada")
    with tempfile.TemporaryDirectory(prefix=f"singalong-backing-{video_id}-") as tmp:
        work = Path(tmp)
        vocals = work / "vocals.mp3"
        vocals.write_bytes(storage.read(vocals_key))
        lead_wav, back_wav = separate_vocals(vocals, work)
        share = backing_share(_load_mono(lead_wav), _load_mono(back_wav))
        status = "ready" if is_usable(share) else "none"
        if status == "ready":
            out = work / "backing.mp3"
            result = subprocess.run(
                ["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", str(back_wav), "-b:a", BITRATE, str(out)],
                capture_output=True, text=True, timeout=FFMPEG_TIMEOUT,
            )
            if result.returncode != 0 or not out.exists():
                raise RuntimeError(f"ffmpeg falhou: {result.stderr.strip()[-300:]}")
            storage.put(backing_key(video_id), out)
    update_meta(storage, video_id, lambda meta: meta.update({"backing": {"status": status, "share": round(share, 3)}}))
    return status


def find_missing(storage) -> list[str]:
    """Ready songs with isolated vocals that have not been analyzed yet (processed before this feature)."""
    missing = []
    for key in [k for k in storage.list("cache") if k.endswith("/meta.json")]:
        video_id = key.split("/")[1]
        try:
            if "backing" not in json.loads(storage.read(key)) and storage.exists(f"cache/{video_id}/vocals.mp3"):
                missing.append(video_id)
        except Exception:  # noqa: BLE001 - uma pasta com problema não impede as outras
            log.warning("não consegui ler o meta de %s", video_id)
    return sorted(missing)


def serve(backend, storage, stop: threading.Event) -> None:
    """The thread's loop: first the old songs without analysis, then the requests for new songs, one at a time."""
    pending = deque(find_missing(storage))
    if pending:
        log.info("vozes de apoio: %d música(s) do cache para analisar em segundo plano", len(pending))
    while not stop.is_set():
        try:
            if not pending:
                video_id = backend.next_backing(2)
                if not video_id:
                    continue
                pending.append(video_id)
            video_id = pending.popleft()
            try:
                status = process(storage, video_id)
                backend.publish_song(video_id)  # local storage: the catalog gains the backing vocals
                log.info("vozes de apoio de %s: %s", video_id, status)
            except Exception as exc:  # noqa: BLE001 - sem o apoio a música continua funcionando; tenta de novo na próxima subida
                log.warning("não consegui separar as vozes de apoio de %s: %s", video_id, exc)
        except Exception:  # noqa: BLE001 - conexão: segue
            log.warning("falha ao atender pedido de vozes de apoio", exc_info=True)
            stop.wait(2)
