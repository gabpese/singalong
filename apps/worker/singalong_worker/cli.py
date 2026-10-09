import argparse
import json
import os
from pathlib import Path

from .errors import classify
from .logsetup import setup_logging
from .pipeline import NeedsLyrics, process
from .storage import LocalStorage


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="singalong_worker", description="YouTube -> instrumental + letra sincronizada")
    p.add_argument("url", nargs="?", help="link do YouTube (ou ID de 11 caracteres); omitido com --consume")
    p.add_argument("--consume", action="store_true", help="modo serviço: consome jobs do Redis (REDIS_URL)")
    p.add_argument("--lyrics", choices=["auto", "video", "lrclib", "file", "text", "align", "none"], default="auto")
    p.add_argument("--loose", action="store_true", help="aceita letra online de versão com duração diferente da do vídeo")
    p.add_argument("--lyrics-file", type=Path, help="com --lyrics file: .lrc/.srt/.vtt com tempos; com --lyrics text ou align: texto puro, uma linha por verso")
    p.add_argument("--device", choices=["cpu", "cuda"], default=os.environ.get("DEMUCS_DEVICE") or None, help="dispositivo do demucs (padrão: automático)")
    p.add_argument("--langs", default="pt,en", help="idiomas de legenda, separados por vírgula")
    p.add_argument("--storage-root", default=os.environ.get("STORAGE_ROOT", "./storage"))
    p.add_argument("--cookies", type=Path, default=os.environ.get("YTDLP_COOKIES") or None, help="cookies.txt (formato Netscape) para o yt-dlp")
    p.add_argument("--artist", help="artista para buscar a letra (sobrescreve a detecção)")
    p.add_argument("--title", help="título da música para buscar a letra (sobrescreve a detecção)")
    p.add_argument("--force", action="store_true", help="ignora e refaz o cache")
    args = p.parse_args(argv)
    setup_logging(level="INFO")

    if args.consume:
        from .consumer import run  # importa só aqui: o modo CLI não precisa do cliente Redis

        run()
        return 0
    if not args.url:
        p.error("informe a url (ou use --consume)")

    storage = LocalStorage(args.storage_root)
    lyrics_text = args.lyrics_file.read_text(encoding="utf-8") if args.lyrics_file else None
    try:
        meta = process(
            args.url, storage, args.lyrics, lyrics_text, args.device, args.langs.split(","), args.force, args.cookies,
            args.artist, args.title, lyrics_loose=args.loose,
        )
    except ValueError as e:
        print(f"erro: {e}")
        return 2
    except NeedsLyrics as e:
        print(f"needs_lyrics: {e}")
        return 3
    except Exception as e:  # noqa: BLE001 - na CLI toda falha vira uma mensagem clara, como no worker
        err = classify(e)
        print(f"erro ({err.code}): {err.message}")
        return 4
    print(json.dumps(meta, ensure_ascii=False, indent=2))
    return 0
