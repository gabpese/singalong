"""O catálogo da biblioteca local: o que o agente publica para a nuvem sobre as músicas que estão neste computador.

A nuvem não vê os arquivos. Para cada música pronta o agente publica o meta.json (título, artista, tom...) e quais arquivos
existem (instrumental, letra, melodia, vozes de apoio e os tons que já têm MP4). O navegador busca os arquivos no servidor
local de mídia (media_server.py). Contrato em apps/api/src/agents.js (PUT /agent/v1/library).
"""
import json
import logging
import re

log = logging.getLogger("worker.catalog")

EXPORT_NAME = re.compile(r"^karaoke(?:_p([+-]\d))?\.mp4$")
MAX_META_CHARS = 18_000  # o servidor recusa meta maior que 20 mil caracteres
VIDEO_ID = re.compile(r"^([A-Za-z0-9_-]{11}|f-[0-9a-f]{12})$")


def exports_of(storage, video_id: str) -> list[int]:
    """Os tons (−6..+6) que já têm um MP4 exportado na pasta da música."""
    pitches = []
    for key in storage.list(f"cache/{video_id}"):
        match = EXPORT_NAME.match(key.rsplit("/", 1)[-1])
        if match:
            pitches.append(int(match.group(1)) if match.group(1) else 0)
    return sorted(set(pitches))


def entry_for(storage, video_id: str) -> dict | None:
    """A entrada do catálogo de uma música pronta (instrumental, letra e meta.json existem); None se ainda não está pronta."""
    if not VIDEO_ID.match(video_id):
        return None
    base = f"cache/{video_id}"
    if not all(storage.exists(f"{base}/{name}") for name in ("instrumental.mp3", "lyrics.json", "meta.json")):
        return None
    try:
        meta = json.loads(storage.read(f"{base}/meta.json"))
    except (ValueError, OSError):
        log.warning("meta.json ilegível", extra={"job": video_id})
        return None
    if not isinstance(meta, dict) or len(json.dumps(meta)) > MAX_META_CHARS:
        return None
    return {
        "id": video_id,
        "meta": meta,
        "files": {
            "instrumental": True,
            "lyrics": True,
            "melody": storage.exists(f"{base}/melody.json"),
            "backing": storage.exists(f"{base}/backing.mp3"),
            "exports": exports_of(storage, video_id),
        },
    }


def scan(storage) -> list[dict]:
    """O catálogo de todas as músicas prontas da biblioteca local."""
    ids = sorted({key.split("/")[1] for key in storage.list("cache") if key.endswith("/meta.json")})
    return [entry for entry in (entry_for(storage, video_id) for video_id in ids) if entry]
