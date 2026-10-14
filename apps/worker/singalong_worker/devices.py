"""Qual dispositivo (GPU ou CPU) cada etapa da IA usa, conforme o motor instalado (a variável SINGALONG_ENGINE, que o app põe no ambiente
do worker a partir do engine.json: cpu, cu121, rocm6.2 ou mps).

- NVIDIA (cu121) e AMD (rocm6.2): o Demucs e o alinhamento escolhem sozinhos; no torch a placa AMD também se chama "cuda".
- Apple (mps): o Demucs roda no Metal, mas o alinhamento da letra (Whisper) fica na CPU: o tempo das palavras usa operações que o Metal
  ainda não tem. Se a separação falhar no Metal, ela é refeita na CPU.
- `DEMUCS_DEVICE` (ou --device) sempre vence."""
import logging
import subprocess
from collections.abc import Mapping
from pathlib import Path

log = logging.getLogger("worker.devices")


def engine_device(env: Mapping[str, str]) -> str | None:
    """O dispositivo do Demucs que o motor pede: "mps" no motor da GPU da Apple; nos outros None (o Demucs escolhe)."""
    return "mps" if env.get("SINGALONG_ENGINE") == "mps" else None


def align_device(device: str | None) -> str | None:
    """O dispositivo do alinhamento da letra: o Metal não serve para ele, então vira CPU."""
    return "cpu" if device == "mps" else device


def separate_with_fallback(separate, audio: Path, workdir: Path, device: str | None, timeout: float | None = None):
    """Roda `separate` (pipeline.separate) e, se a GPU da Apple falhar no meio, refaz na CPU em vez de perder a música."""
    try:
        return separate(audio, workdir, device, timeout)
    except subprocess.CalledProcessError as exc:
        if device != "mps":
            raise
        log.warning("a separação na GPU da Apple falhou (%s); refazendo na CPU", exc)
        return separate(audio, workdir, "cpu", timeout)
