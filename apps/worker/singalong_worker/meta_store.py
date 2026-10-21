"""Safe updates to a song's meta.json.

Several background tasks (the video title, the key, the backing vocals) fill in the meta.json of finished songs. Each one
READS, CHANGES and WRITES the whole file; without coordination, one would overwrite the other's change. Here the read
happens inside the lock, so a change always starts from the latest file. The slow computation (the key, the separation)
stays outside the lock: only the "read, change and write" is serialized.
"""
import json
import tempfile
import threading
from collections.abc import Callable
from pathlib import Path

_lock = threading.Lock()


def meta_key(video_id: str) -> str:
    return f"cache/{video_id}/meta.json"


def update_meta(storage, video_id: str, mutate: Callable[[dict], None]) -> dict:
    """Applies `mutate(meta)` (which changes the dict in place) to the latest meta.json and writes it. Returns the new meta."""
    key = meta_key(video_id)
    with _lock:
        meta = json.loads(storage.read(key))
        mutate(meta)
        with tempfile.TemporaryDirectory(prefix="singalong-meta-") as tmp:
            updated = Path(tmp) / "meta.json"
            updated.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
            storage.put(key, updated)
    return meta
