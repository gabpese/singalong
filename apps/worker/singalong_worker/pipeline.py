"""An idempotent pipeline: each stage runs only if its artifact does not exist in storage yet."""
import json
import logging
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from . import lyrics as lyr
from .align import align_lyrics, attach_words
from .cookies import CookiePolicy, as_policy, run_with_policy
from .devices import align_device, separate_with_fallback
from .errors import JobError, format_duration, NEVER, MANUAL
from .ids import extract_video_id
from .importer import ImportedSong
from .key import detect_key
from .melody import extract_melody
from .storage import LocalStorage

PIPELINE_VERSION = 1

log = logging.getLogger("worker.pipeline")

# the default limits (the worker reads them from the environment: MAX_DURATION_SECONDS, MIN_FREE_GB, SEPARATE_TIMEOUT_SECONDS)
DEFAULT_MAX_DURATION = 15 * 60
DEFAULT_MIN_FREE_GB = 2.0
DEFAULT_SEPARATE_TIMEOUT = 15 * 60

_TITLE_NOISE = re.compile(r"\s*[\(\[][^\)\]]*\)?[\]\)]?\s*$")


def guess_artist_title(video_title: str) -> tuple[str | None, str | None]:
    """'Artist - Song (Cover/Official...)' -> (Artist, Song). Without ' - ' in the title, it does not guess."""
    if " - " not in video_title:
        return None, None
    artist, title = video_title.split(" - ", 1)
    while True:  # removes repeated () and [] suffixes
        cleaned = _TITLE_NOISE.sub("", title)
        if cleaned == title or not cleaned:
            break
        title = cleaned
    return artist.strip() or None, title.strip() or None


class NeedsLyrics(Exception):
    """A video without manual subtitles and no usable lyrics source."""


def keys(video_id: str) -> dict[str, str]:
    base = f"cache/{video_id}"
    return {
        "instrumental": f"{base}/instrumental.mp3",
        "vocals": f"{base}/vocals.mp3",  # the vocals alone: used to align the lyrics the user pasted
        "lyrics": f"{base}/lyrics.json",
        "melody": f"{base}/melody.json",  # optional: the original voice's melody, for the Score
        "meta": f"{base}/meta.json",
        "source": f"{base}/source.json",  # the video's metadata: avoids downloading again just to change the lyrics
    }


def is_ready(storage: LocalStorage, video_id: str) -> bool:
    k = keys(video_id)
    return all(storage.exists(k[name]) for name in ("instrumental", "lyrics", "meta"))




@dataclass(frozen=True)
class Limits:
    """Limits that protect the machine from huge videos, a full disk and hangs."""

    max_duration: float | None = DEFAULT_MAX_DURATION  # seconds; None = no limit
    min_free_gb: float = DEFAULT_MIN_FREE_GB
    separate_timeout: float | None = DEFAULT_SEPARATE_TIMEOUT

    @classmethod
    def from_env(cls) -> "Limits":
        """MAX_DURATION_SECONDS, MIN_FREE_GB and SEPARATE_TIMEOUT_SECONDS (0 turns each limit off)."""

        def number(name: str, default: float) -> float:
            try:
                return float(os.environ.get(name, default))
            except ValueError:
                return default

        return cls(
            max_duration=number("MAX_DURATION_SECONDS", DEFAULT_MAX_DURATION) or None,
            min_free_gb=number("MIN_FREE_GB", DEFAULT_MIN_FREE_GB),
            separate_timeout=number("SEPARATE_TIMEOUT_SECONDS", DEFAULT_SEPARATE_TIMEOUT) or None,
        )


def validate_video_info(info: dict, max_duration: float | None) -> None:
    """Refuses early (before downloading) what will not work or is not worth the cost: live, private and too long."""
    if info.get("is_live") or info.get("live_status") in ("is_live", "is_upcoming"):
        raise JobError("live", "Este vídeo é uma transmissão ao vivo (ou uma estreia agendada) e ainda não pode ser baixado.", NEVER)
    availability = info.get("availability")
    if availability == "private":
        raise JobError("private", "Este vídeo é privado. Escolha outro vídeo.", NEVER)
    if availability == "subscriber_only":
        raise JobError("members", "Este vídeo é só para membros do canal. Escolha outro vídeo.", NEVER)
    duration = info.get("duration")
    if max_duration and duration and duration > max_duration:
        raise JobError(
            "too_long",
            f"O vídeo tem {format_duration(duration)} e o limite é {format_duration(max_duration)} "
            "(vídeos assim costumam ser coletâneas ou álbuns inteiros). Escolha uma versão só da música.",
            NEVER,
        )


def check_disk(path, min_free_gb: float) -> None:
    """Does not start processing without space: separating the vocals makes hundreds of MB of temporary files.

    The library folder may not exist yet (the first run of a new install): it measures the closest existing folder.
    """
    probe = Path(path)
    while not probe.exists() and probe.parent != probe:
        probe = probe.parent
    free = shutil.disk_usage(probe).free / 1024**3
    if min_free_gb and free < min_free_gb:
        raise JobError("disk_full", f"Pouco espaço em disco ({free:.1f} GB livres; o mínimo é {min_free_gb:g} GB). Libere espaço e tente de novo.", MANUAL)


def download(
    url: str, workdir: Path, langs: list[str], cookies: "CookiePolicy | Path | None" = None, max_duration: float | None = None
) -> dict:
    """Downloads the audio and the MANUAL subtitles (auto-subtitles are left out on purpose).

    `cookies`: the cookie policy (cookies.py): no cookie first and, if YouTube asks for a login, with the account. A cookies.txt
    path counts as "always"; None, as "never".
    """
    return run_with_policy(as_policy(cookies), lambda opts: _download(url, workdir, langs, opts, max_duration), workdir)


def _download(url: str, workdir: Path, langs: list[str], cookie_opts: dict, max_duration: float | None) -> dict:
    import yt_dlp  # a late import: only whoever downloads needs it (the tests and reading the cache do not)

    base = {
        "outtmpl": str(workdir / "source.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "noprogress": True,
        "no_warnings": True,
        **cookie_opts,
    }

    # 1) the audio is essential: if it fails, the job fails
    audio_opts = {**base, "format": "bestaudio/best", "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "wav"}]}
    with yt_dlp.YoutubeDL(audio_opts) as ydl:
        info = ydl.extract_info(url, download=False)  # the data only: it can refuse before spending bandwidth
        validate_video_info(info, max_duration)
        info = ydl.process_ie_result(info, download=True)  # downloads without extracting again

    # 2) the subtitles are optional (there are other lyrics sources): only tries if the video HAS manual subtitles, and
    #    never brings the job down (YouTube often answers 429 to the subtitles endpoint)
    subtitle_text = None
    subtitle_error = None
    wanted =manual_subtitle_langs(info.get("subtitles") or {}, langs)
    if wanted:
        sub_opts = {**base, "skip_download": True, "writesubtitles": True, "writeautomaticsub": False,
                    "subtitleslangs": wanted, "subtitlesformat": "vtt/srt"}
        try:
            with yt_dlp.YoutubeDL(sub_opts) as ydl:
                ydl.extract_info(url, download=True)
            subs = sorted(workdir.glob("source.*.vtt")) + sorted(workdir.glob("source.*.srt"))
            subtitle_text = subs[0].read_text(encoding="utf-8", errors="replace") if subs else None
        except yt_dlp.utils.DownloadError as exc:
            log.warning("legenda do vídeo indisponível (%s); seguindo sem ela", exc)
            subtitle_error = str(exc)

    return {
        "video_title": info.get("title"),
        "track": info.get("track"),
        "artist": info.get("artist") or info.get("creator"),  # no fallback to the channel: it is often wrong for covers
        "duration": info.get("duration"),
        "subtitle_text": subtitle_text,
        "subtitle_error": subtitle_error,  # the video HAS manual subtitles, but the download failed (e.g. 429)
        "audio": workdir / "source.wav",
    }


def manual_subtitle_langs(available: dict, langs: list[str]) -> list[str]:
    """The available MANUAL subtitle languages that match the requested ones ('en' matches 'en' and 'en-US'), in the requested order."""
    chosen: list[str] = []
    for want in langs:
        for lang in available:
            if (lang == want or lang.startswith(want + "-")) and lang not in chosen:
                chosen.append(lang)
    return chosen


def separate(audio: Path, workdir: Path, device: str | None, timeout: float | None = None) -> tuple[Path, Path]:
    """Demucs (htdemucs, 2 stems) -> (instrumental.mp3, vocals.mp3). The vocals stay in the cache: they serve the lyrics alignment."""
    out = workdir / "demucs"
    cmd = [sys.executable, "-m", "demucs", "--two-stems=vocals", "-n", "htdemucs", "-o", str(out), str(audio)]
    if device:
        cmd += ["-d", device]
    subprocess.run(cmd, check=True, timeout=timeout)  # TimeoutExpired becomes "took too long"
    paths = []
    for stem, name in (("no_vocals.wav", "instrumental.mp3"), ("vocals.wav", "vocals.mp3")):
        mp3 = workdir / name
        subprocess.run(
            ["ffmpeg", "-y", "-loglevel", "error", "-i", str(next(out.rglob(stem))), "-codec:a", "libmp3lame", "-q:a", "2", str(mp3)],
            check=True,
        )
        paths.append(mp3)
    return paths[0], paths[1]


class NeedsAlignment(Exception):
    """There is the lyrics' TEXT but not the timings: the AI must sync it with the vocals.

    origin: 'align' (the user asked for it), 'text' (the user pasted it, with no timing reference) or 'lrclib' (text found online).
    """

    def __init__(self, text: str, origin: str):
        super().__init__(origin)
        self.text = text
        self.origin = origin


def _search_online(info: dict) -> list[dict]:
    if not (info["artist"] and info["title"]):
        raise NeedsLyrics("Não consegui descobrir o artista e o nome da música pelo título do vídeo. Preencha os campos Artista e Título.")
    try:
        return lyr.search_lrclib(info["artist"], info["title"], info["duration"])
    except lyr.LyricsServiceError as exc:
        # an outside service being down is not the job's failure: the user can try again or pick another option
        raise NeedsLyrics("O serviço de busca de letras na internet não respondeu agora. Tente de novo em instantes.") from exc


def timing_donor(info: dict, loose: bool = False) -> tuple[list[dict], str]:
    """Lyrics with timings to serve as a base: the video's subtitles, otherwise the online version with the same duration."""
    if info.get("subtitle_text"):
        return lyr.parse_cues(info["subtitle_text"]), "video"
    chosen, _closest = lyr.pick_candidate(_search_online(info), info["duration"], loose=loose)
    if not chosen:
        raise NeedsLyrics("Não achei essa letra com tempos, na duração deste vídeo.")
    return lyr.parse_lrc(chosen["syncedLyrics"]), "lrclib"


def online_lyrics(info: dict, loose: bool = False) -> tuple[list[dict], str]:
    """Searches online: uses the ready timings when the duration matches; otherwise returns the TEXT for the AI to sync."""
    candidates = _search_online(info)
    chosen, _closest = lyr.pick_candidate(candidates, info["duration"], loose=loose)
    if chosen:
        return lyr.parse_lrc(chosen["syncedLyrics"]), "lrclib"
    best = lyr.best_text_candidate(candidates, info["duration"])
    if best:
        raise NeedsAlignment(lyr.candidate_text(best), "lrclib")
    raise NeedsLyrics("Não achei essa letra na internet. Confira o artista e o nome da música, ou cole a letra.")


def resolve_lyrics(
    source: str, info: dict, lyrics_text: str | None, loose: bool = False
) -> tuple[list[dict], str]:
    """source: auto | video | lrclib | file | text | align | none. Returns (cues, source_used).

    Raises NeedsAlignment when there is only the text (the AI syncs it later) and NeedsLyrics when a user's decision is missing.
    lyrics_text: with 'file', lyrics WITH timings (LRC/SRT/VTT); with 'text'/'align', plain lyrics.
    loose: uses online lyrics of a version with a different duration, with their timings (no AI).
    """
    if source == "none":
        return [], "none"
    if source in ("auto", "video") and info.get("subtitle_text"):
        return timing_donor(info, loose)
    if source == "video":
        raise NeedsLyrics("Este vídeo não tem legenda que eu consiga usar.")
    if source in ("file", "text", "align") and not (lyrics_text or "").strip():
        raise ValueError("Cole a letra no campo de texto.")
    if source == "file":
        return lyr.parse_lyrics_file(lyrics_text), "file"
    if source == "align":
        raise NeedsAlignment(lyrics_text, "align")
    if source == "text":
        # tries another source's timings; with no reference (or a different number of lines), the AI syncs
        try:
            timed, donor = timing_donor(info, loose)
            return lyr.apply_text(lyrics_text, timed), f"text+{donor}"
        except (NeedsLyrics, ValueError):
            raise NeedsAlignment(lyrics_text, "text") from None
    if source == "lrclib":
        return online_lyrics(info, loose)
    if info.get("subtitle_error"):
        raise NeedsLyrics(
            "O vídeo tem legenda, mas o YouTube bloqueou o download dela por excesso de pedidos. "
            "Escolha outra opção de letra (ou tente de novo mais tarde)."
        )
    raise NeedsLyrics("Este vídeo não tem legenda. Escolha como você quer a letra.")


def music_key(storage: LocalStorage, k: dict[str, str], work: Path, instrumental: Path | None) -> dict | None:
    """The song's key: reuses the one already computed; otherwise estimates it from the instrumental.

    It is an extra: any failure in the analysis becomes "no key" and never brings the job down.
    """
    try:
        if storage.exists(k["meta"]):
            previous = json.loads(storage.read(k["meta"])).get("key")
            if previous:
                return previous
        audio = instrumental
        if audio is None:
            audio = work / "instrumental.mp3"
            audio.write_bytes(storage.read(k["instrumental"]))
        return detect_key(audio)
    except Exception as exc:  # noqa: BLE001
        log.warning("não consegui calcular o tom (%s: %s)", type(exc).__name__, exc)
        return None


def _write_json(path: Path, data, **kwargs) -> Path:
    path.write_text(json.dumps(data, ensure_ascii=False, **kwargs), encoding="utf-8")
    return path


def process(
    url: str,
    storage: LocalStorage,
    lyrics_source: str = "auto",
    lyrics_text: str | None = None,
    device: str | None = None,
    langs: list[str] | None = None,
    force: bool = False,
    cookies: Path | None = None,
    artist: str | None = None,
    title: str | None = None,
    on_stage: Callable[[str], None] | None = None,
    lyrics_loose: bool = False,
    limits: Limits | None = None,
    imported: "ImportedSong | None" = None,
) -> dict:
    """Stages reported through on_stage: downloading, separating, lyrics, aligning.

    lyrics_source: auto | video | lrclib | file | text | align | none ('align' syncs `lyrics_text` with the vocals, through AI).
    imported: a song that does NOT come from YouTube (the user's file or an open source; importer.py): the audio is already ready,
    so there is no download and `url` is ignored. The rest of the path is the same.
    """
    notify = on_stage or (lambda stage: None)
    limits = limits or Limits.from_env()
    video_id = imported.video_id if imported else extract_video_id(url)
    if not video_id:
        raise ValueError(f"URL do YouTube inválida: {url!r}")
    k = keys(video_id)
    if force:
        storage.delete(f"cache/{video_id}")
    # an explicit lyrics source redoes only the lyrics (the instrumental stays in the cache)
    if lyrics_source == "auto" and is_ready(storage, video_id):
        log.info("%s já está pronto (cache)", video_id)
        return json.loads(storage.read(k["meta"]))

    check_disk(storage.root, limits.min_free_gb)

    timings: dict[str, float] = {}
    with tempfile.TemporaryDirectory(prefix=f"singalong-{video_id}-") as tmp:
        work = Path(tmp)
        audio = None
        instrumental_file: Path | None = None
        vocals_file: Path | None = None

        need_separation = not storage.exists(k["instrumental"])  # the vocals, if missing, are fetched only when the AI needs them

        if storage.exists(k["source"]) and not need_separation:
            log.info("%s: metadados do vídeo no cache, sem baixar", video_id)
            info = json.loads(storage.read(k["source"]))
        elif imported:
            info = dict(imported.info)  # the audio already came from outside (a file or an open source): nothing to download
            audio = imported.audio
        else:
            notify("downloading")
            t = time.monotonic()
            log.info("%s: baixando", video_id)
            info = download(f"https://www.youtube.com/watch?v={video_id}", work, langs or ["pt", "en"], cookies, limits.max_duration)
            audio = info.pop("audio")
            timings["download"] = round(time.monotonic() - t, 1)

        # priority: the given artist/title > YouTube's metadata > the video title's "Artist - Song"
        info["artist_override"] = artist or info.get("artist_override")
        info["title_override"] = title or info.get("title_override")
        _write_json(work / "source.json", info)
        storage.put(k["source"], work / "source.json")
        g_artist, g_title = guess_artist_title(info["video_title"] or "")
        info["artist"] = info["artist_override"] or info["artist"] or g_artist
        info["title"] = info["title_override"] or info["track"] or g_title or info["video_title"]

        if need_separation:
            notify("separating")
            t = time.monotonic()
            log.info("%s: separando a voz (demucs)", video_id)
            instrumental_file, vocals_file = separate_with_fallback(separate, audio, work, device, limits.separate_timeout)
            storage.put(k["instrumental"], instrumental_file)
            storage.put(k["vocals"], vocals_file)
            timings["separate"] = round(time.monotonic() - t, 1)
        else:
            log.info("%s: instrumental já existe, pulando a separação", video_id)

        def get_vocals() -> Path:
            """The isolated vocals: from the cache or (old songs, without vocals.mp3) downloaded and separated again."""
            nonlocal vocals_file
            if vocals_file is not None:
                return vocals_file
            if storage.exists(k["vocals"]):
                vocals_file = work / "vocals.mp3"
                vocals_file.write_bytes(storage.read(k["vocals"]))
                return vocals_file
            if imported:  # the source audio is no longer here to separate again: import the file again
                raise JobError("no_vocals", "A voz isolada desta música não está na biblioteca. Importe o arquivo de novo (com --force).", MANUAL)
            notify("downloading")
            fresh = download(f"https://www.youtube.com/watch?v={video_id}", work, langs or ["pt", "en"], cookies, limits.max_duration)
            notify("separating")
            instrumental_file, vocals_file = separate_with_fallback(separate, fresh["audio"], work, device, limits.separate_timeout)
            if not storage.exists(k["instrumental"]):
                storage.put(k["instrumental"], instrumental_file)
            storage.put(k["vocals"], vocals_file)
            return vocals_file

        notify("lyrics")
        log.info("%s: resolvendo a letra", video_id)
        try:
            cues, source = resolve_lyrics(lyrics_source, info, lyrics_text, lyrics_loose)
        except NeedsAlignment as need:
            # there is the text but not the timings: the AI finds out when each line is sung by listening to the vocals
            if not need.text.strip():
                raise ValueError("Cole a letra no campo de texto.") from None
            vocals = get_vocals()
            notify("aligning")
            t = time.monotonic()
            log.info("%s: alinhando a letra com a voz (IA; texto: %s)", video_id, need.origin)
            cues = align_lyrics(vocals, need.text, device=align_device(device))
            source = "lrclib+align" if need.origin == "lrclib" else "align"
            timings["align"] = round(time.monotonic() - t, 1)
        words_lines = sum(1 for c in cues if c.get("words"))
        if cues and not words_lines and os.environ.get("WORD_TIMING", "on").lower() not in ("off", "0", "false"):
            # lyrics timed only by line (subtitles, LRCLIB, a file): the AI listens to the vocals and finds each word's timing
            try:
                vocals = get_vocals()
                notify("aligning")
                t = time.monotonic()
                log.info("%s: medindo o tempo de cada palavra (IA)", video_id)
                aligned = align_lyrics(vocals, "\n".join(c["text"] for c in cues), device=align_device(device))
                cues, words_lines = attach_words(cues, aligned)
                timings["words"] = round(time.monotonic() - t, 1)
            except Exception as exc:  # noqa: BLE001 - é um refinamento: sem ele a letra continua valendo
                log.warning("%s: não consegui medir as palavras (%s); o destaque será estimado", video_id, exc)
        storage.put(k["lyrics"], _write_json(work / "lyrics.json", cues))

        if not storage.exists(k["melody"]) and (vocals_file is not None or storage.exists(k["vocals"])):
            # songs without isolated vocals (an old cache) get no Score: not worth downloading and separating again just for that
            try:
                t = time.monotonic()
                log.info("%s: extraindo a melodia da voz", video_id)
                storage.put(k["melody"], _write_json(work / "melody.json", extract_melody(get_vocals(), cues)))
                timings["melody"] = round(time.monotonic() - t, 1)
            except Exception as exc:  # noqa: BLE001 - é um extra: sem ele a música só não pontua
                log.warning("%s: não consegui extrair a melodia (%s); a música não terá pontuação", video_id, exc)

        t = time.monotonic()
        key = music_key(storage, k, work, instrumental_file)
        if key and "key" not in timings:
            timings["key"] = round(time.monotonic() - t, 1)

        previous = json.loads(storage.read(k["meta"])) if storage.exists(k["meta"]) else {}
        meta = {
            "video_id": video_id,
            "title": info["title"],
            "artist": info["artist"],
            "video_title": info.get("video_title"),  # the Jukebox also searches by it
            "duration": info["duration"],
            **({"origin": info["origin"]} if info.get("origin") else {}),  # file | url:<site>: a song that did not come from YouTube
            "lyrics_source": source,
            "lyrics_lines": len(cues),
            "lyrics_word_timing": words_lines > 0,
            **({"key": key} if key else {}),
            **({"backing": previous["backing"]} if "backing" in previous else {}),  # the isolated vocals did not change: the backing still holds
            "pipeline_version": PIPELINE_VERSION,
            "timings_s": timings,
        }
        storage.put(k["meta"], _write_json(work / "meta.json", meta, indent=2))  # last: marks it "ready"
    return meta
