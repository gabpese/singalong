"""Vozes de apoio (backing vocals) separadas da voz principal, para o controle de nível das vozes de apoio.

O Demucs entrega só "voz" e "instrumental", e a voz mistura a principal com as de apoio. Um segundo passo, com um modelo de
"karaokê" do UVR (MDX-Net), separa a voz isolada em principal e apoio; o apoio vira `cache/<id>/backing.mp3`. A TV toca
instrumental + apoio com o volume que quem escolheu a música definir.

Não bloqueia a música: ela fica pronta sem o apoio e uma thread própria o gera depois (leva minutos em CPU). Músicas sem
apoio de verdade (uma voz só) ficam marcadas `backing.status = "none"` e não ganham o arquivo.

Contrato (Redis, documentado em apps/api/src/jobs.js):
  lista  "backing:req"   o worker faz LPUSH do video_id quando uma música fica pronta
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

REQUEST_KEY = "backing:req"
MODEL = "UVR_MDXNET_KARA_2.onnx"
MODEL_DIR = os.environ.get("BACKING_MODEL_DIR", "/models/audio-separator")
SAMPLE_RATE = 22050
FRAME = 2048
# o apoio conta se, em pelo menos 5% dos trechos com voz principal, chega a -15 dB dela (0,178 em amplitude)
CLOSE_RATIO = 0.178
MIN_SHARE = 0.05
BITRATE = "128k"
FFMPEG_TIMEOUT = 300

_separator = None  # o modelo carrega uma vez só (leva alguns segundos e baixa na primeira vez)


def backing_key(video_id: str) -> str:
    return f"cache/{video_id}/backing.mp3"


def backing_share(lead, back) -> float:
    """Fração dos trechos com voz principal em que o apoio chega perto dela (≥ -15 dB). 0 = uma voz só."""
    import numpy as np

    def rms(y):
        frames = len(y) // FRAME
        return np.sqrt((np.asarray(y[: frames * FRAME], dtype=float).reshape(frames, FRAME) ** 2).mean(axis=1)) if frames else np.zeros(0)

    lead_rms, back_rms = rms(lead), rms(back)
    n = min(len(lead_rms), len(back_rms))
    lead_rms, back_rms = lead_rms[:n], back_rms[:n]
    if not n:
        return 0.0
    active = lead_rms > np.percentile(lead_rms, 50) * 0.3  # onde a voz principal canta
    if not active.any():
        return 0.0
    return float(np.mean(back_rms[active] > lead_rms[active] * CLOSE_RATIO))


def is_usable(share: float) -> bool:
    return share >= MIN_SHARE


def _load_separator(work: Path):
    global _separator
    from audio_separator.separator import Separator  # pesado: só o worker precisa

    if _separator is None:
        _separator = Separator(output_dir=str(work), output_format="WAV", model_file_dir=MODEL_DIR, log_level=30)
        _separator.load_model(model_filename=MODEL)
    _separator.output_dir = str(work)
    return _separator


def separate_vocals(vocals: Path, work: Path) -> tuple[Path, Path]:
    """(voz principal, vozes de apoio) em WAV. O modelo chama a principal de "Vocals" e o apoio de "Instrumental"."""
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
    """Separa as vozes de apoio de uma música pronta. Devolve "ready" ou "none" (e grava no meta.json)."""
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
    """Músicas prontas, com a voz isolada, que ainda não foram analisadas (processadas antes deste recurso)."""
    missing = []
    for key in [k for k in storage.list("cache") if k.endswith("/meta.json")]:
        video_id = key.split("/")[1]
        try:
            if "backing" not in json.loads(storage.read(key)) and storage.exists(f"cache/{video_id}/vocals.mp3"):
                missing.append(video_id)
        except Exception:  # noqa: BLE001 - uma pasta com problema não impede as outras
            log.warning("não consegui ler o meta de %s", video_id)
    return sorted(missing)


def serve(redis_url: str, storage, stop: threading.Event) -> None:
    """Loop da thread: primeiro as músicas antigas sem análise, depois os pedidos de músicas novas, uma de cada vez."""
    import redis  # import tardio: os testes não precisam do cliente Redis

    r = redis.Redis.from_url(redis_url, decode_responses=True, socket_timeout=30, socket_connect_timeout=5)
    pending = deque(find_missing(storage))
    if pending:
        log.info("vozes de apoio: %d música(s) do cache para analisar em segundo plano", len(pending))
    while not stop.is_set():
        try:
            if not pending:
                item = r.brpop(REQUEST_KEY, timeout=2)
                if not item:
                    continue
                pending.append(item[1])
            video_id = pending.popleft()
            try:
                status = process(storage, video_id)
                log.info("vozes de apoio de %s: %s", video_id, status)
            except Exception as exc:  # noqa: BLE001 - sem o apoio a música continua funcionando; tenta de novo na próxima subida
                log.warning("não consegui separar as vozes de apoio de %s: %s", video_id, exc)
        except Exception:  # noqa: BLE001 - conexão: segue
            log.warning("falha ao atender pedido de vozes de apoio", exc_info=True)
            stop.wait(2)
