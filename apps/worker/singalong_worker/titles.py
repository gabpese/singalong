"""Título do vídeo do YouTube de cada música do cache, para o Jukebox achar a música também por ele.

O `meta.json` guarda o nome que a pessoa deu (artista e música); o título original do vídeo ("Faouzia - Unethical (MAPHRA
Vocal Cover)") ajuda a achar a mesma música quando ela foi pedida com outro nome. Músicas processadas antes deste recurso
já têm o título no `source.json`: o backfill o copia para o `meta.json`.
"""
import json
import logging

from .meta_store import update_meta

log = logging.getLogger("worker.titles")


def backfill(storage) -> int:
    """Copia `video_title` do source.json para o meta.json das músicas que ainda não têm. Devolve quantas atualizou."""
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
