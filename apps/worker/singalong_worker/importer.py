"""Importing songs without YouTube: an audio file of the user's own or a link from an open source.

The pipeline needs only ONE audio file; downloading from YouTube is just the first stage. Here the audio comes from elsewhere
and follows the same path (separating the vocals, resolving the lyrics, melody, key, meta). The id is `f-` + the first 12
hexadecimal characters of the SHA-256 of the audio's CONTENT: the same file imported twice lands on the same song.

Security (TRD, section 8.1):
  - file: only the listed extensions, limited size and duration, validated by ffprobe (it must have an audio track);
    the server never names a path: whoever imports picks the file on their own computer;
  - link: only the listed sites (the exact domain or a subdomain, never a name that only ENDS the same), no cookies, and yt-dlp may
    only use those sites' SINGLE-TRACK extractors (no search, album, playlist, YouTube or generic page).
Whoever imports is responsible for the file's origin (personal use): the app does not check it.
"""
import hashlib
import json
import logging
import os
import re
import subprocess
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit

from .errors import MANUAL, NEVER, JobError, format_duration

log = logging.getLogger("worker.import")

AUDIO_EXTENSIONS = (".mp3", ".flac", ".wav", ".m4a", ".ogg", ".opus")
DEFAULT_MAX_MB = 200
OPEN_HOSTS = ("soundcloud.com", "bandcamp.com", "archive.org")
# the yt-dlp extractors allowed, matched by their NAME (IE_NAME, e.g. "soundcloud", "Bandcamp", "archive.org"): only the
# single-track ones of the sites above. Playlists, albums and searches have names with ":" ("soundcloud:playlist", "Bandcamp:album").
OPEN_EXTRACTORS = (r"(?i)^soundcloud$", r"(?i)^bandcamp$", r"(?i)^archive\.org$")
ID_RE = re.compile(r"^f-[0-9a-f]{12}$")
HASH_CHUNK = 1024 * 1024


@dataclass
class ImportedSong:
    """What the pipeline needs from a song that did not come from YouTube."""

    video_id: str  # "f-<12 hex>"
    audio: Path  # decodable audio (wav) in the work folder
    info: dict  # video_title, track, artist, duration, subtitle_text, subtitle_error, origin


def max_bytes(env=os.environ) -> int:
    try:
        return int(float(env.get("IMPORT_MAX_MB", DEFAULT_MAX_MB)) * 1024 * 1024)
    except ValueError:
        return DEFAULT_MAX_MB * 1024 * 1024


def file_id(path: Path) -> str:
    """An imported song's id: "f-" + 12 hexadecimal characters of the content's SHA-256."""
    digest = hashlib.sha256()
    with Path(path).open("rb") as fh:
        for chunk in iter(lambda: fh.read(HASH_CHUNK), b""):
            digest.update(chunk)
    return f"f-{digest.hexdigest()[:12]}"


def _tag(tags: dict, *names: str) -> str | None:
    lowered = {str(k).lower(): v for k, v in (tags or {}).items()}
    for name in names:
        value = str(lowered.get(name, "")).strip()
        if value:
            return value
    return None


def probe_audio(path: Path, run: Callable = subprocess.run) -> dict:
    """Asks ffprobe what the file is: { duration, title, artist, codec }. Refuses what is not readable audio."""
    try:
        result = run(
            ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(path)],
            capture_output=True, text=True, timeout=60,
        )
    except FileNotFoundError as exc:
        raise JobError("audio", "O ffmpeg não está instalado neste computador (preciso do ffprobe para ler o áudio).", MANUAL) from exc
    except subprocess.TimeoutExpired as exc:
        raise JobError("audio", "Demorei demais para ler este arquivo de áudio.", MANUAL) from exc
    unreadable = JobError("bad_audio", "Não consegui ler este arquivo como áudio. Escolha um mp3, flac, wav, m4a, ogg ou opus válido.", NEVER)
    if result.returncode != 0:
        raise unreadable
    try:
        data = json.loads(result.stdout or "{}")
    except ValueError as exc:
        raise unreadable from exc
    streams = [s for s in data.get("streams", []) if s.get("codec_type") == "audio"]
    if not streams:
        raise unreadable
    fmt = data.get("format", {})
    try:
        duration = float(fmt.get("duration") or streams[0].get("duration") or 0)
    except (TypeError, ValueError):
        duration = 0.0
    if duration <= 0:
        raise unreadable
    tags = {**(streams[0].get("tags") or {}), **(fmt.get("tags") or {})}
    return {"duration": duration, "title": _tag(tags, "title"), "artist": _tag(tags, "artist", "album_artist"), "codec": streams[0].get("codec_name")}


def to_wav(source: Path, dest: Path, run: Callable = subprocess.run) -> Path:
    """Decodes to wav (what Demucs reads): this also proves the file plays to the end."""
    result = run(["ffmpeg", "-y", "-loglevel", "error", "-i", str(source), "-vn", "-acodec", "pcm_s16le", str(dest)], capture_output=True, text=True, timeout=600)
    if result.returncode != 0 or not dest.exists():
        raise JobError("bad_audio", "Não consegui decodificar este arquivo de áudio. Ele pode estar corrompido.", NEVER)
    return dest


def prepare_file(
    path: Path,
    workdir: Path,
    max_duration: float | None,
    max_size: int | None = None,
    run: Callable = subprocess.run,
) -> ImportedSong:
    """Validates the file the user picked and prepares it (a wav in the work folder). Nothing is moved or deleted."""
    path = Path(path)
    if not path.is_file():
        raise JobError("bad_audio", f"Não encontrei o arquivo: {path}", NEVER)
    if path.suffix.lower() not in AUDIO_EXTENSIONS:
        raise JobError("bad_audio", f"Formato não aceito ({path.suffix or 'sem extensão'}). Use {', '.join(AUDIO_EXTENSIONS)}.", NEVER)
    limit = max_size if max_size is not None else max_bytes()
    size = path.stat().st_size
    if limit and size > limit:
        raise JobError("too_big", f"O arquivo tem {size / 1024 / 1024:.0f} MB e o limite é {limit / 1024 / 1024:.0f} MB.", NEVER)
    probe = probe_audio(path, run)
    if max_duration and probe["duration"] > max_duration:
        raise JobError(
            "too_long",
            f"O áudio tem {format_duration(probe['duration'])} e o limite é {format_duration(max_duration)}. Escolha o arquivo de uma música só.",
            NEVER,
        )
    wav = to_wav(path, workdir / "source.wav", run)
    return ImportedSong(
        video_id=file_id(path),
        audio=wav,
        info={
            "video_title": path.stem,  # the Jukebox also searches by it (the file's name, without the extension)
            "track": probe["title"], "artist": probe["artist"], "duration": probe["duration"],
            "subtitle_text": None, "subtitle_error": None, "origin": "file",
        },
    )


def host_allowed(url: str) -> str | None:
    """The allowed domain ("soundcloud.com"...) if the link is from a listed open source; None if not.

    Only the exact domain or a subdomain of it counts: "notsoundcloud.com" and "soundcloud.com.evil.example" do not; neither
    does a protocol other than http(s), credentials in the address or a different port.
    """
    try:
        parts = urlsplit(url.strip())
        port = parts.port
    except ValueError:
        return None
    host = (parts.hostname or "").lower().rstrip(".")
    if parts.scheme not in ("http", "https") or parts.username or parts.password or port not in (None, 80, 443):
        return None
    for allowed in OPEN_HOSTS:
        if host == allowed or host.endswith("." + allowed):
            return allowed
    return None


def _open_error(exc: Exception) -> JobError:
    text = str(exc).lower()
    if "no suitable extractor" in text or "unsupported url" in text:
        return JobError("not_open_source", "Este link não é de uma música de uma fonte aberta (use o link de UMA faixa de SoundCloud, Bandcamp ou Internet Archive).", NEVER)
    if any(word in text for word in ("login", "sign in", "private", "paywall", "purchase", "preview", "geo", "unavailable", "404", "403")):
        return JobError("not_downloadable", "Este link não permite baixar a música (ela é privada, paga ou só tem prévia). Só funciona quando o autor permite o download.", NEVER)
    return JobError("download_failed", f"Não consegui baixar deste link ({type(exc).__name__}). Tente de novo ou use outro link.", MANUAL)


def prepare_url(url: str, workdir: Path, max_duration: float | None, ydl_factory: Callable | None = None) -> ImportedSong:
    """Downloads the track of a link from an open source (SoundCloud, Bandcamp, Internet Archive), without cookies, and prepares it."""
    domain = host_allowed(url)
    if not domain:
        raise JobError("not_open_source", f"Só aceito links de {', '.join(OPEN_HOSTS)} (o link de uma faixa).", NEVER)
    if ydl_factory is None:
        import yt_dlp  # a late import: only whoever downloads needs it

        ydl_factory = yt_dlp.YoutubeDL
    opts = {
        "outtmpl": str(workdir / "source.%(ext)s"), "noplaylist": True, "quiet": True, "noprogress": True, "no_warnings": True,
        "format": "bestaudio/best", "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "wav"}],
        "allowed_extractors": list(OPEN_EXTRACTORS),  # single-track ones only: no search, playlist, album, YouTube or generic page
        "socket_timeout": 30,
        # never uses the YouTube account (or other cookies): these sites do not need them
    }
    try:
        with ydl_factory(opts) as ydl:
            info = ydl.extract_info(url, download=False)
            if info.get("_type") in ("playlist", "multi_video") or info.get("entries"):
                raise JobError("not_open_source", "Este link é de um álbum ou lista. Use o link de UMA faixa.", NEVER)
            if info.get("is_live"):
                raise JobError("live", "Este link é uma transmissão ao vivo e não pode ser baixado.", NEVER)
            duration = info.get("duration")
            if max_duration and duration and duration > max_duration:
                raise JobError("too_long", f"O áudio tem {format_duration(duration)} e o limite é {format_duration(max_duration)}. Escolha uma faixa só.", NEVER)
            info = ydl.process_ie_result(info, download=True)
    except JobError:
        raise
    except Exception as exc:  # noqa: BLE001 - a mensagem diz o que fazer
        raise _open_error(exc) from exc
    wav = workdir / "source.wav"
    if not wav.exists():
        raise JobError("download_failed", "O download terminou, mas não achei o áudio. Tente de novo.", MANUAL)
    return ImportedSong(
        video_id=file_id(wav),
        audio=wav,
        info={
            "video_title": info.get("title"),
            "track": info.get("track") or info.get("title"),
            "artist": info.get("artist") or info.get("creator") or info.get("uploader"),
            "duration": info.get("duration"),
            "subtitle_text": None, "subtitle_error": None, "origin": f"url:{domain}",
        },
    )


def resolve_names(info: dict, artist: str | None, title: str | None) -> tuple[str | None, str | None]:
    """Artist and title as the pipeline resolves them: what was given > the tags/metadata > the guess from the title."""
    from .pipeline import guess_artist_title  # a late import: the pipeline imports this module

    guessed_artist, guessed_title = guess_artist_title(info.get("video_title") or "")
    return (
        (artist or info.get("artist") or guessed_artist or "").strip() or None,
        (title or info.get("track") or guessed_title or info.get("video_title") or "").strip() or None,
    )


def import_song(
    storage,
    file: Path | str | None = None,
    url: str | None = None,
    artist: str | None = None,
    title: str | None = None,
    limits=None,
    on_stage: Callable[[str], None] | None = None,
    force: bool = False,
    lyrics_source: str = "auto",
    **process_kwargs,
) -> dict:
    """Imports ONE song (from a file or a link from an open source) and leaves it ready in the library. Returns the meta.

    Artist and name are required (they come from the file's tags, its name or `artist`/`title`): they feed the lyrics search
    and what shows in the queue. Importing the same file again returns the song that already exists (unless `force`).
    """
    from .pipeline import Limits, is_ready, keys, process  # a late import: the pipeline imports this module

    if bool(file) == bool(url):
        raise ValueError("Informe um arquivo OU um link para importar.")
    limits = limits or Limits.from_env()
    notify = on_stage or (lambda stage: None)
    if file:
        known = file_id(Path(file)) if Path(file).is_file() else None
        if known and not force and lyrics_source == "auto" and is_ready(storage, known):
            log.info("%s já está na biblioteca (mesmo conteúdo)", known)
            return json.loads(storage.read(keys(known)["meta"]))
    import tempfile

    with tempfile.TemporaryDirectory(prefix="singalong-import-") as tmp:
        notify("importing")
        work = Path(tmp)
        imported = prepare_file(Path(file), work, limits.max_duration) if file else prepare_url(url, work, limits.max_duration)
        # the same song (the same content) already in the library: reuses its artist and name if they were not given again
        existing = json.loads(storage.read(keys(imported.video_id)["meta"])) if is_ready(storage, imported.video_id) else {}
        final_artist, final_title = resolve_names(imported.info, artist or existing.get("artist"), title or existing.get("title"))
        if not (final_artist and final_title):
            raise JobError(
                "artist_title_required",
                "Não consegui descobrir o artista e o nome da música (nem pelas etiquetas, nem pelo nome do arquivo). Informe os dois (--artist e --title).",
                MANUAL,
            )
        if not force and lyrics_source == "auto" and is_ready(storage, imported.video_id):
            log.info("%s já está na biblioteca (mesmo conteúdo)", imported.video_id)
            return json.loads(storage.read(keys(imported.video_id)["meta"]))
        return process(
            None, storage, lyrics_source=lyrics_source, artist=final_artist, title=final_title, limits=limits, on_stage=notify,
            force=force, imported=imported, **process_kwargs,
        )
