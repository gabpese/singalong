"""Pipeline idempotente: cada etapa só roda se o artefato ainda não existe no storage."""
import json
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import yt_dlp

from . import lyrics as lyr
from .ids import extract_video_id
from .storage import LocalStorage

PIPELINE_VERSION = 1

_TITLE_NOISE = re.compile(r"\s*[\(\[][^\)\]]*\)?[\]\)]?\s*$")


def guess_artist_title(video_title: str) -> tuple[str | None, str | None]:
    """'Artista - Música (Cover/Official...)' -> (Artista, Música). Sem ' - ' no título, não chuta."""
    if " - " not in video_title:
        return None, None
    artist, title = video_title.split(" - ", 1)
    while True:  # remove sufixos entre () e [] repetidos
        cleaned = _TITLE_NOISE.sub("", title)
        if cleaned == title or not cleaned:
            break
        title = cleaned
    return artist.strip() or None, title.strip() or None


class NeedsLyrics(Exception):
    """Vídeo sem legenda manual e nenhuma fonte de letra utilizável."""


def keys(video_id: str) -> dict[str, str]:
    base = f"cache/{video_id}"
    return {
        "instrumental": f"{base}/instrumental.mp3",
        "lyrics": f"{base}/lyrics.json",
        "meta": f"{base}/meta.json",
    }


def is_ready(storage: LocalStorage, video_id: str) -> bool:
    k = keys(video_id)
    return all(storage.exists(k[name]) for name in ("instrumental", "lyrics", "meta"))


def download(url: str, workdir: Path, langs: list[str], cookies: Path | None = None) -> dict:
    """Baixa o áudio e as legendas MANUAIS (auto-legendas ficam de fora de propósito)."""
    opts = {
        "format": "bestaudio/best",
        "outtmpl": str(workdir / "source.%(ext)s"),
        "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "wav"}],
        "writesubtitles": True,
        "writeautomaticsub": False,
        "subtitleslangs": langs,
        "subtitlesformat": "vtt/srt",
        "noplaylist": True,
        "quiet": True,
        "noprogress": True,
        "no_warnings": True,
    }
    if cookies:
        # yt-dlp regrava o arquivo ao fechar; usa uma cópia para o original poder ser somente leitura
        cookie_copy = workdir / "cookies.txt"
        shutil.copyfile(cookies, cookie_copy)
        opts["cookiefile"] = str(cookie_copy)
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=True)
    subs = sorted(workdir.glob("source.*.vtt")) + sorted(workdir.glob("source.*.srt"))
    return {
        "video_title": info.get("title"),
        "track": info.get("track"),
        "artist": info.get("artist") or info.get("creator"),  # sem fallback para o canal: costuma errar em covers
        "duration": info.get("duration"),
        "audio": workdir / "source.wav",
        "subtitle_file": subs[0] if subs else None,
    }


def separate(audio: Path, workdir: Path, device: str | None) -> Path:
    """Demucs (htdemucs, 2 stems) -> no_vocals.wav -> instrumental.mp3."""
    out = workdir / "demucs"
    cmd = [sys.executable, "-m", "demucs", "--two-stems=vocals", "-n", "htdemucs", "-o", str(out), str(audio)]
    if device:
        cmd += ["-d", device]
    subprocess.run(cmd, check=True)
    no_vocals = next(out.rglob("no_vocals.wav"))
    mp3 = workdir / "instrumental.mp3"
    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(no_vocals), "-codec:a", "libmp3lame", "-q:a", "2", str(mp3)],
        check=True,
    )
    return mp3


def timing_donor(info: dict) -> tuple[list[dict], str]:
    """Letra com tempos para servir de base: legenda do vídeo, senão LRCLIB."""
    if info["subtitle_file"]:
        text = info["subtitle_file"].read_text(encoding="utf-8", errors="replace")
        return lyr.parse_cues(text), "video"
    if not (info["artist"] and info["title"]):
        raise NeedsLyrics("sem artista/título para buscar no LRCLIB (use --artist e --title)")
    results = lyr.search_lrclib(info["artist"], info["title"], info["duration"])
    if not results:
        raise NeedsLyrics("nenhuma letra sincronizada compatível no LRCLIB")
    return lyr.parse_lrc(results[0]["syncedLyrics"]), "lrclib"


def resolve_lyrics(source: str, info: dict, lyrics_file: Path | None) -> tuple[list[dict], str]:
    """source: auto | video | lrclib | file | text. Devolve (cues, fonte_usada)."""
    if source in ("auto", "video") and info["subtitle_file"]:
        return timing_donor(info)
    if source == "video":
        raise NeedsLyrics("o vídeo não tem legenda manual")
    if source in ("file", "text") and not lyrics_file:
        raise ValueError(f"--lyrics {source} exige --lyrics-file")
    if source == "file":
        return lyr.parse_lyrics_file(lyrics_file.read_text(encoding="utf-8")), "file"
    if source == "text":
        timed, donor = timing_donor(info)
        return lyr.apply_text(lyrics_file.read_text(encoding="utf-8"), timed), f"text+{donor}"
    if source == "lrclib":
        return timing_donor(info)
    raise NeedsLyrics("sem legenda no vídeo: escolha --lyrics lrclib, file ou text")


def process(
    url: str,
    storage: LocalStorage,
    lyrics_source: str = "auto",
    lyrics_file: Path | None = None,
    device: str | None = None,
    langs: list[str] | None = None,
    force: bool = False,
    cookies: Path | None = None,
    artist: str | None = None,
    title: str | None = None,
) -> dict:
    video_id = extract_video_id(url)
    if not video_id:
        raise ValueError(f"URL do YouTube inválida: {url!r}")
    k = keys(video_id)
    if force:
        storage.delete(f"cache/{video_id}")
    # fonte de letra explícita refaz só a letra (o instrumental continua no cache)
    if lyrics_source == "auto" and is_ready(storage, video_id):
        print(f"[cache] {video_id} já está pronto")
        return json.loads(storage.read(k["meta"]))

    timings: dict[str, float] = {}
    with tempfile.TemporaryDirectory(prefix=f"singalong-{video_id}-") as tmp:
        work = Path(tmp)

        t = time.monotonic()
        print(f"[1/3] baixando {video_id}...")
        info = download(f"https://www.youtube.com/watch?v={video_id}", work, langs or ["pt", "en"], cookies)
        timings["download"] = round(time.monotonic() - t, 1)
        # prioridade: --artist/--title > metadados do YouTube > "Artista - Música" do título do vídeo
        g_artist, g_title = guess_artist_title(info["video_title"] or "")
        info["artist"] = artist or info["artist"] or g_artist
        info["title"] = title or info["track"] or g_title or info["video_title"]

        if not storage.exists(k["instrumental"]):
            t = time.monotonic()
            print("[2/3] separando vocal (demucs)...")
            storage.put(k["instrumental"], separate(info["audio"], work, device))
            timings["separate"] = round(time.monotonic() - t, 1)
        else:
            print("[2/3] instrumental já existe, pulando")

        print("[3/3] resolvendo letra...")
        cues, source = resolve_lyrics(lyrics_source, info, lyrics_file)
        lyrics_json = work / "lyrics.json"
        lyrics_json.write_text(json.dumps(cues, ensure_ascii=False), encoding="utf-8")
        storage.put(k["lyrics"], lyrics_json)

        meta = {
            "video_id": video_id,
            "title": info["title"],
            "artist": info["artist"],
            "duration": info["duration"],
            "lyrics_source": source,
            "lyrics_lines": len(cues),
            "pipeline_version": PIPELINE_VERSION,
            "timings_s": timings,
        }
        meta_json = work / "meta.json"
        meta_json.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        storage.put(k["meta"], meta_json)  # meta por último: marca o item como "pronto"
    return meta
