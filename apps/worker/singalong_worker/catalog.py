"""The local library's catalog: what the agent publishes to the cloud about the songs on this computer.

The cloud does not see the files. For each ready song the agent publishes its meta.json (title, artist, key...) and which
files exist (instrumental, lyrics, melody, backing vocals and the keys that already have an MP4). The browser fetches the
files from the local media server (media_server.py). Contract in apps/api/src/agents/agent.controller.ts
(PUT /agent/v1/library).
"""
import json
import logging
import re

log = logging.getLogger("worker.catalog")

EXPORT_NAME = re.compile(r"^karaoke(?:_p([+-]\d))?\.mp4$")
MAX_META_CHARS = 18_000  # the server refuses a meta longer than 20,000 characters
VIDEO_ID = re.compile(r"^([A-Za-z0-9_-]{11}|f-[0-9a-f]{12})$")


def exports_of(storage, video_id: str) -> list[int]:
    """The keys (−6..+6) that already have an exported MP4 in the song's folder."""
    pitches = []
    for key in storage.list(f"cache/{video_id}"):
        match = EXPORT_NAME.match(key.rsplit("/", 1)[-1])
        if match:
            pitches.append(int(match.group(1)) if match.group(1) else 0)
    return sorted(set(pitches))


def entry_for(storage, video_id: str) -> dict | None:
    """The catalog entry of a ready song (instrumental, lyrics and meta.json exist); None if it is not ready yet."""
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
            "vocals": storage.exists(f"{base}/vocals.mp3"),
            "exports": exports_of(storage, video_id),
        },
    }


def scan(storage) -> list[dict]:
    """The catalog of every ready song in the local library."""
    ids = sorted({key.split("/")[1] for key in storage.list("cache") if key.endswith("/meta.json")})
    return [entry for entry in (entry_for(storage, video_id) for video_id in ids) if entry]
