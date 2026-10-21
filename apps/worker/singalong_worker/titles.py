"""The YouTube video title of each cached song, so the Jukebox also finds the song by it.

`meta.json` keeps the name the person gave (artist and song); the video's original title ("Faouzia - Unethical (MAPHRA
Vocal Cover)") helps find the same song when it was asked for under another name. Songs processed before this feature
already have the title in `source.json`: the backfill copies it to `meta.json`.
"""
import json
import logging

from .meta_store import update_meta

log = logging.getLogger("worker.titles")


def backfill(storage) -> int:
    """Copies `video_title` from source.json to the meta.json of the songs that lack it. Returns how many it updated."""
    done = 0
    for meta_key_path in [k for k in storage.list("cache") if k.endswith("/meta.json")]:
        base = meta_key_path.rsplit("/", 1)[0]
        video_id = base.split("/")[1]
        try:
            if json.loads(storage.read(meta_key_path)).get("video_title") or not storage.exists(f"{base}/source.json"):
                continue
            video_title = json.loads(storage.read(f"{base}/source.json")).get("video_title")
            if not video_title:
                continue
            update_meta(storage, video_id, lambda meta: meta.setdefault("video_title", video_title))
            done += 1
        except Exception as exc:  # noqa: BLE001 - uma música com problema não impede as outras
            log.warning("não consegui guardar o título do vídeo de %s: %s", base, exc)
    if done:
        log.info("título do vídeo guardado em %d música(s) do cache", done)
    return done
