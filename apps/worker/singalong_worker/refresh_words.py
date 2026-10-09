"""Completa as músicas já no cache (sem refazer download nem separação): tempo de cada palavra e melodia (pontuação).

Uso: python -m singalong_worker.refresh_words [--device cuda] [ID ...]
Os tempos das linhas não mudam; só ganham `words` e `melody.json`. Músicas sem vocals.mp3 são puladas.
"""
import argparse
import json
import os
import tempfile
from pathlib import Path

from .align import align_lyrics, attach_words
from .logsetup import setup_logging
from .melody import extract_melody
from .pipeline import keys
from .storage import LocalStorage


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("ids", nargs="*")
    p.add_argument("--melody", action="store_true", help="refaz também a melodia que já existe (ex.: depois de mudar o filtro)")
    p.add_argument("--device", choices=["cpu", "cuda"], default=os.environ.get("DEMUCS_DEVICE") or None)
    p.add_argument("--storage-root", default=os.environ.get("STORAGE_ROOT", "./storage"))
    args = p.parse_args()
    setup_logging(level="INFO")
    storage = LocalStorage(args.storage_root)
    ids = args.ids or sorted({k.split("/")[1] for k in storage.list("cache") if k.endswith("/meta.json")})
    for vid in ids:
        k = keys(vid)
        if not (storage.exists(k["meta"]) and storage.exists(k["lyrics"]) and storage.exists(k["vocals"])):
            print(f"{vid}: pulada (sem voz isolada)")
            continue
        meta = json.loads(storage.read(k["meta"]))
        need_words = not meta.get("lyrics_word_timing")
        need_melody = args.melody or not storage.exists(k["melody"])
        if not (need_words or need_melody):
            print(f"{vid}: pulada")
            continue
        with tempfile.TemporaryDirectory() as tmp:
            vocals = Path(tmp) / "vocals.mp3"
            vocals.write_bytes(storage.read(k["vocals"]))
            if need_words:
                cues = json.loads(storage.read(k["lyrics"]))
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
            if need_melody:
                melody = Path(tmp) / "melody.json"
                melody.write_text(json.dumps(extract_melody(vocals, json.loads(storage.read(k["lyrics"])))), encoding="utf-8")
                storage.put(k["melody"], melody)
                print(f"{vid}: melodia extraída")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
