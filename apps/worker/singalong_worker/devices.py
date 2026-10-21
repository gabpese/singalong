"""Which device (GPU or CPU) each AI stage uses, for the installed engine (the SINGALONG_ENGINE variable, which the app sets in
the worker's environment from engine.json: cpu, cu121, rocm6.2 or mps).

- NVIDIA (cu121) and AMD (rocm6.2): Demucs and the alignment choose by themselves; in torch the AMD card is also called "cuda".
- Apple (mps): Demucs runs on Metal, but the lyrics alignment (Whisper) stays on the CPU: the word timings use operations Metal
  does not have yet. If the separation fails on Metal, it runs again on the CPU.
- `DEMUCS_DEVICE` (or --device) always wins."""
import logging
import subprocess
from collections.abc import Mapping
from pathlib import Path

log = logging.getLogger("worker.devices")


def engine_device(env: Mapping[str, str]) -> str | None:
    """The Demucs device the engine asks for: "mps" on the Apple GPU engine; None on the others (Demucs chooses)."""
    return "mps" if env.get("SINGALONG_ENGINE") == "mps" else None


def align_device(device: str | None) -> str | None:
    """The lyrics alignment's device: Metal does not work for it, so it becomes the CPU."""
    return "cpu" if device == "mps" else device


def separate_with_fallback(separate, audio: Path, workdir: Path, device: str | None, timeout: float | None = None):
    """Runs `separate` (pipeline.separate) and, if Apple's GPU fails midway, runs it again on the CPU instead of losing the song."""
    try:
        return separate(audio, workdir, device, timeout)
    except subprocess.CalledProcessError as exc:
        if device != "mps":
            raise
        log.warning("a separação na GPU da Apple falhou (%s); refazendo na CPU", exc)
        return separate(audio, workdir, "cpu", timeout)
