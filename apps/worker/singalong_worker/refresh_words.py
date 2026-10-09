"""Mede o tempo de cada palavra das músicas já no cache (sem refazer download nem separação).

Uso: python -m singalong_worker.refresh_words [--device cuda] [ID ...]
Os tempos das linhas não mudam; só ganham `words`. Músicas sem vocals.mp3 são puladas.
"""
import argparse
import json
import os
import tempfile
from pathlib import Path

from .align import align_lyrics, attach_words
from .logsetup import setup_logging
from .pipeline import keys
from .storage import LocalStorage


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("ids", nargs="*")
    p.add_argument("--device", choices=["cpu", "cuda"], default=os.environ.get("DEMUCS_DEVICE") or None)
    p.add_argument("--storage-root", default=os.environ.get("STORAGE_ROOT", "./storage"))
    args = p.parse_args()
    setup_logging(level="INFO")
    storage = LocalStorage(args.storage_root)
    ids = args.ids or sorted({k.split("/")[1] for k in storage.list("cache") if k.endswith("/meta.json")})
    for vid in ids:
        k = keys(vid)
        meta = json.loads(storage.read(k["meta"]))
        if meta.get("lyrics_word_timing") or not storage.exists(k["lyrics"]) or not storage.exists(k["vocals"]):
            print(f"{vid}: pulada")
            continue
        cues = json.loads(storage.read(k["lyrics"]))
        with tempfile.TemporaryDirectory() as tmp:
            vocals = Path(tmp) / "vocals.mp3"
            vocals.write_bytes(storage.read(k["vocals"]))
            aligned = align_lyrics(vocals, "\n".join(c["text"] for c in cues), device=args.device)
            cues, n = attach_words(cues, aligned)
            lyrics = Path(tmp) / "lyrics.json"
            lyrics.write_text(json.dumps(cues, ensure_ascii=False), encoding="utf-8")
            meta["lyrics_word_timing"] = n > 0
            metaf = Path(tmp) / "meta.json"
            metaf.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
            storage.put(k["lyrics"], lyrics)
            storage.put(k["meta"], metaf)
        print(f"{vid}: {n}/{len(cues)} linhas com palavras")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
