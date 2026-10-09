"""Pipeline idempotente: cada etapa só roda se o artefato ainda não existe no storage."""
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
from .align import align_lyrics
from .errors import JobError, format_duration, NEVER, MANUAL
from .ids import extract_video_id
from .key import detect_key
from .storage import LocalStorage

PIPELINE_VERSION = 1

log = logging.getLogger("worker.pipeline")

# limites padrão (o worker os lê do ambiente: MAX_DURATION_SECONDS, MIN_FREE_GB, SEPARATE_TIMEOUT_SECONDS)
DEFAULT_MAX_DURATION = 15 * 60
DEFAULT_MIN_FREE_GB = 2.0
DEFAULT_SEPARATE_TIMEOUT = 15 * 60

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
        "vocals": f"{base}/vocals.mp3",  # só a voz: usada para alinhar a letra colada pelo usuário
        "lyrics": f"{base}/lyrics.json",
        "meta": f"{base}/meta.json",
        "source": f"{base}/source.json",  # metadados do vídeo: evita baixar de novo só para trocar a letra
    }


def is_ready(storage: LocalStorage, video_id: str) -> bool:
    k = keys(video_id)
    return all(storage.exists(k[name]) for name in ("instrumental", "lyrics", "meta"))




@dataclass(frozen=True)
class Limits:
    """Limites que protegem a máquina de vídeos enormes, disco cheio e travamentos."""

    max_duration: float | None = DEFAULT_MAX_DURATION  # segundos; None = sem limite
    min_free_gb: float = DEFAULT_MIN_FREE_GB
    separate_timeout: float | None = DEFAULT_SEPARATE_TIMEOUT

    @classmethod
    def from_env(cls) -> "Limits":
        """MAX_DURATION_SECONDS, MIN_FREE_GB e SEPARATE_TIMEOUT_SECONDS (0 desliga cada limite)."""

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
    """Recusa cedo (antes de baixar) o que não dá certo ou não vale o custo: ao vivo, privado e longo demais."""
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
    """Não começa um processamento sem espaço: separar a voz gera centenas de MB de arquivos temporários."""
    free = shutil.disk_usage(path).free / 1024**3
    if min_free_gb and free < min_free_gb:
        raise JobError("disk_full", f"Pouco espaço em disco ({free:.1f} GB livres; o mínimo é {min_free_gb:g} GB). Libere espaço e tente de novo.", MANUAL)


def download(
    url: str, workdir: Path, langs: list[str], cookies: Path | None = None, max_duration: float | None = None
) -> dict:
    """Baixa o áudio e as legendas MANUAIS (auto-legendas ficam de fora de propósito)."""
    import yt_dlp  # import tardio: só quem baixa precisa dele (testes e consumo do cache não)

    base = {
        "outtmpl": str(workdir / "source.%(ext)s"),
        "noplaylist": True,
        "quiet": True,
        "noprogress": True,
        "no_warnings": True,
    }
    if cookies:
        # yt-dlp regrava o arquivo ao fechar; usa uma cópia para o original poder ser somente leitura
        cookie_copy = workdir / "cookies.txt"
        shutil.copyfile(cookies, cookie_copy)
        base["cookiefile"] = str(cookie_copy)

    # 1) o áudio é essencial: se falhar, o job falha
    audio_opts = {**base, "format": "bestaudio/best", "postprocessors": [{"key": "FFmpegExtractAudio", "preferredcodec": "wav"}]}
    with yt_dlp.YoutubeDL(audio_opts) as ydl:
        info = ydl.extract_info(url, download=False)  # só os dados: dá para recusar antes de gastar banda
        validate_video_info(info, max_duration)
        info = ydl.process_ie_result(info, download=True)  # baixa sem extrair de novo

    # 2) a legenda é opcional (há outras fontes de letra): só tenta se o vídeo TEM legenda manual e
    #    nunca derruba o job (o YouTube responde 429 ao endpoint de legendas com frequência)
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
        "artist": info.get("artist") or info.get("creator"),  # sem fallback para o canal: costuma errar em covers
        "duration": info.get("duration"),
        "subtitle_text": subtitle_text,
        "subtitle_error": subtitle_error,  # o vídeo TEM legenda manual, mas o download falhou (ex.: 429)
        "audio": workdir / "source.wav",
    }


def manual_subtitle_langs(available: dict, langs: list[str]) -> list[str]:
    """Idiomas de legenda MANUAL disponíveis que casam com os pedidos ('en' casa com 'en' e 'en-US'), na ordem pedida."""
    chosen: list[str] = []
    for want in langs:
        for lang in available:
            if (lang == want or lang.startswith(want + "-")) and lang not in chosen:
                chosen.append(lang)
    return chosen


def separate(audio: Path, workdir: Path, device: str | None, timeout: float | None = None) -> tuple[Path, Path]:
    """Demucs (htdemucs, 2 stems) -> (instrumental.mp3, vocals.mp3). A voz fica no cache: serve ao alinhamento da letra."""
    out = workdir / "demucs"
    cmd = [sys.executable, "-m", "demucs", "--two-stems=vocals", "-n", "htdemucs", "-o", str(out), str(audio)]
    if device:
        cmd += ["-d", device]
    subprocess.run(cmd, check=True, timeout=timeout)  # TimeoutExpired vira "demorou demais"
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
    """Há o TEXTO da letra mas não os tempos: a IA precisa sincronizá-lo com a voz.

    origin: 'align' (o usuário pediu), 'text' (o usuário colou, sem referência de tempo) ou 'lrclib' (texto achado online).
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
        # serviço externo fora do ar não é falha do job: o usuário pode tentar de novo ou escolher outra opção
        raise NeedsLyrics("O serviço de busca de letras na internet não respondeu agora. Tente de novo em instantes.") from exc


def timing_donor(info: dict, loose: bool = False) -> tuple[list[dict], str]:
    """Letra com tempos para servir de base: legenda do vídeo, senão a versão online de mesma duração."""
    if info.get("subtitle_text"):
        return lyr.parse_cues(info["subtitle_text"]), "video"
    chosen, _closest = lyr.pick_candidate(_search_online(info), info["duration"], loose=loose)
    if not chosen:
        raise NeedsLyrics("Não achei essa letra com tempos, na duração deste vídeo.")
    return lyr.parse_lrc(chosen["syncedLyrics"]), "lrclib"


def online_lyrics(info: dict, loose: bool = False) -> tuple[list[dict], str]:
    """Busca na internet: usa os tempos prontos quando a duração bate; senão devolve o TEXTO para a IA sincronizar."""
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
    """source: auto | video | lrclib | file | text | align | none. Devolve (cues, fonte_usada).

    Levanta NeedsAlignment quando só há o texto (a IA sincroniza depois) e NeedsLyrics quando falta uma decisão do usuário.
    lyrics_text: com 'file', letra COM tempos (LRC/SRT/VTT); com 'text'/'align', letra pura.
    loose: usa letra online de versão com duração diferente, com os tempos dela (sem IA).
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
        # tenta os tempos de outra fonte; sem referência (ou com número de linhas diferente), a IA sincroniza
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
    """Tom da música: reaproveita o já calculado; senão estima a partir do instrumental.

    É um extra: qualquer falha na análise vira "sem tom" e nunca derruba o job.
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
) -> dict:
    """Etapas informadas em on_stage: downloading, separating, lyrics, aligning.

    lyrics_source: auto | video | lrclib | file | text | align | none ('align' sincroniza `lyrics_text` com a voz, por IA).
    """
    notify = on_stage or (lambda stage: None)
    limits = limits or Limits.from_env()
    video_id = extract_video_id(url)
    if not video_id:
        raise ValueError(f"URL do YouTube inválida: {url!r}")
    k = keys(video_id)
    if force:
        storage.delete(f"cache/{video_id}")
    # fonte de letra explícita refaz só a letra (o instrumental continua no cache)
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

        need_separation = not storage.exists(k["instrumental"])  # a voz, se faltar, é obtida só quando a IA precisar

        if storage.exists(k["source"]) and not need_separation:
            log.info("%s: metadados do vídeo no cache, sem baixar", video_id)
            info = json.loads(storage.read(k["source"]))
        else:
            notify("downloading")
            t = time.monotonic()
            log.info("%s: baixando", video_id)
            info = download(f"https://www.youtube.com/watch?v={video_id}", work, langs or ["pt", "en"], cookies, limits.max_duration)
            audio = info.pop("audio")
            timings["download"] = round(time.monotonic() - t, 1)

        # prioridade: artista/título informados > metadados do YouTube > "Artista - Música" do título do vídeo
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
            instrumental_file, vocals_file = separate(audio, work, device, limits.separate_timeout)
            storage.put(k["instrumental"], instrumental_file)
            storage.put(k["vocals"], vocals_file)
            timings["separate"] = round(time.monotonic() - t, 1)
        else:
            log.info("%s: instrumental já existe, pulando a separação", video_id)

        def get_vocals() -> Path:
            """A voz isolada: do cache, ou (músicas antigas, sem vocals.mp3) baixa e separa de novo."""
            nonlocal vocals_file
            if vocals_file is not None:
                return vocals_file
            if storage.exists(k["vocals"]):
                vocals_file = work / "vocals.mp3"
                vocals_file.write_bytes(storage.read(k["vocals"]))
                return vocals_file
            notify("downloading")
            fresh = download(f"https://www.youtube.com/watch?v={video_id}", work, langs or ["pt", "en"], cookies, limits.max_duration)
            notify("separating")
            instrumental_file, vocals_file = separate(fresh["audio"], work, device, limits.separate_timeout)
            if not storage.exists(k["instrumental"]):
                storage.put(k["instrumental"], instrumental_file)
            storage.put(k["vocals"], vocals_file)
            return vocals_file

        notify("lyrics")
        log.info("%s: resolvendo a letra", video_id)
        try:
            cues, source = resolve_lyrics(lyrics_source, info, lyrics_text, lyrics_loose)
        except NeedsAlignment as need:
            # há o texto, faltam os tempos: a IA descobre quando cada linha é cantada, ouvindo a voz
            if not need.text.strip():
                raise ValueError("Cole a letra no campo de texto.") from None
            vocals = get_vocals()
            notify("aligning")
            t = time.monotonic()
            log.info("%s: alinhando a letra com a voz (IA; texto: %s)", video_id, need.origin)
            cues = align_lyrics(vocals, need.text, device=device)
            source = "lrclib+align" if need.origin == "lrclib" else "align"
            timings["align"] = round(time.monotonic() - t, 1)
        storage.put(k["lyrics"], _write_json(work / "lyrics.json", cues))

        t = time.monotonic()
        key = music_key(storage, k, work, instrumental_file)
        if key and "key" not in timings:
            timings["key"] = round(time.monotonic() - t, 1)

        meta = {
            "video_id": video_id,
            "title": info["title"],
            "artist": info["artist"],
            "duration": info["duration"],
            "lyrics_source": source,
            "lyrics_lines": len(cues),
            **({"key": key} if key else {}),
            "pipeline_version": PIPELINE_VERSION,
            "timings_s": timings,
        }
        storage.put(k["meta"], _write_json(work / "meta.json", meta, indent=2))  # por último: marca como "pronto"
    return meta
