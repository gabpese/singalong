import argparse
import json
import os
from pathlib import Path

from .pipeline import NeedsLyrics, process
from .storage import LocalStorage


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="singalong_worker", description="YouTube -> instrumental + letra sincronizada")
    p.add_argument("url", help="link do YouTube (ou ID de 11 caracteres)")
    p.add_argument("--lyrics", choices=["auto", "video", "lrclib", "file", "text"], default="auto")
    p.add_argument("--lyrics-file", type=Path, help="com --lyrics file: .lrc/.srt/.vtt com tempos; com --lyrics text: texto puro, uma linha por verso")
    p.add_argument("--device", choices=["cpu", "cuda"], help="dispositivo do demucs (padrão: automático)")
    p.add_argument("--langs", default="pt,en", help="idiomas de legenda, separados por vírgula")
    p.add_argument("--storage-root", default=os.environ.get("STORAGE_ROOT", "./storage"))
    p.add_argument("--cookies", type=Path, default=os.environ.get("YTDLP_COOKIES") or None, help="cookies.txt (formato Netscape) para o yt-dlp")
    p.add_argument("--artist", help="artista para buscar a letra (sobrescreve a detecção)")
    p.add_argument("--title", help="título da música para buscar a letra (sobrescreve a detecção)")
    p.add_argument("--force", action="store_true", help="ignora e refaz o cache")
    args = p.parse_args(argv)

    storage = LocalStorage(args.storage_root)
    try:
        meta = process(
            args.url, storage, args.lyrics, args.lyrics_file, args.device, args.langs.split(","), args.force, args.cookies,
            args.artist, args.title,
        )
    except ValueError as e:
        print(f"erro: {e}")
        return 2
    except NeedsLyrics as e:
        print(f"needs_lyrics: {e}")
        return 3
    print(json.dumps(meta, ensure_ascii=False, indent=2))
    return 0
