"""Exports the song as a karaoke MP4 video: the instrumental + lyrics that fill word by word.

The lyrics become an ASS subtitle (the \\kf karaoke effect, with each word's real timings when they exist) burned over a
plain background; the key changes, if asked, with ffmpeg's rubberband filter.

The requests' transport (Redis or HTTP) is in backend.py; the contract with the API is in apps/api/src/jobs.ts.
"""
import json
import logging
import re
import subprocess
import tempfile
import threading
import time
from pathlib import Path

from .storage import LocalStorage

log = logging.getLogger("worker.export")

WIDTH, HEIGHT, FPS = 1280, 720, 25
LEAD = 1.5  # the line shows up 1.5 s before it is sung
HOLD = 0.8  # ...and stays 0.8 s after
TITLE_SECONDS = 6.0
LONG_LINE = 70  # lines longer than this use a smaller font (otherwise they take three lines and touch the next one)
FFMPEG_TIMEOUT = 900

# ASS: colors in &HAABBGGRR. In karaoke the text goes from SecondaryColour (not sung yet) to PrimaryColour (sung).
HEADER = f"""[Script Info]
ScriptType: v4.00+
PlayResX: {WIDTH}
PlayResY: {HEIGHT}
WrapStyle: 0
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Current,DejaVu Sans,64,&H004DD3FF,&H00FFFFFF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,4,1,5,70,70,0,1
Style: Next,DejaVu Sans,42,&H00C8C8D2,&H00C8C8D2,&H00000000,&H64000000,0,0,0,0,100,100,0,0,1,3,1,5,90,90,0,1
Style: Title,DejaVu Sans,60,&H004DD3FF,&H004DD3FF,&H00000000,&H64000000,-1,0,0,0,100,100,0,0,1,4,1,5,70,70,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""


def ass_time(seconds: float) -> str:
    cs = max(0, round(seconds * 100))
    return f"{cs // 360000}:{cs // 6000 % 60:02d}:{cs // 100 % 60:02d}.{cs % 100:02d}"


def _clean(text: str) -> str:
    """Text safe for ASS: no braces (tags), backslashes or line breaks."""
    return " ".join(text.replace("{", "(").replace("}", ")").replace("\\", "/").split())


def word_times(cue: dict) -> list[tuple[float, float]]:
    """Each word's start and end in the line: the real timings (`words`) or an estimate from each word's length."""
    words = cue["text"].split()
    real = cue.get("words")
    if real and len(real) == len(words):
        return [(float(s), float(e)) for s, e in real]
    start, end = float(cue["start"]), float(cue["end"])
    weights = [max(len(w), 1) for w in words]
    total = sum(weights) or 1
    out, cursor = [], start
    for weight in weights:
        span = (end - start) * weight / total
        out.append((cursor, cursor + span))
        cursor += span
    return out


def karaoke_text(cue: dict, appear: float) -> str:
    """The line's text with the fill timings (centiseconds), from the moment `appear` when it shows up."""
    words = _clean(cue["text"]).split()
    times = word_times({**cue, "text": " ".join(words)})
    parts, cursor = [], appear
    for i, (word, (s, _e)) in enumerate(zip(words, times)):
        wait = round((s - cursor) * 100)
        if wait > 0:
            parts.append(f"{{\\k{wait}}}")
            cursor += wait / 100
        # each word fills until the next one starts (or until its own end, for the last): no gaps in the effect
        end = times[i + 1][0] if i + 1 < len(words) else times[i][1]
        fill = max(round((end - cursor) * 100), 1)
        cursor += fill / 100
        parts.append(f"{{\\kf{fill}}}{word}{' ' if i < len(words) - 1 else ''}")
    return "".join(parts)


def build_ass(cues: list[dict], title: str, artist: str | None, duration: float) -> str:
    """The ASS subtitle: a title card at the start, the current line in karaoke and the next one, in gray, right below."""
    cues = [c for c in cues if c.get("text", "").strip()]
    events = []
    card = _clean(title)
    if artist:
        card += f"\\N{{\\fs38\\1c&H00C8C8D2&}}{_clean(artist)}"
    title_end = min(TITLE_SECONDS, max(float(cues[0]["start"]) - LEAD, 1.0)) if cues else max(duration, TITLE_SECONDS)
    events.append(f"Dialogue: 0,{ass_time(0)},{ass_time(title_end)},Title,,0,0,0,,{card}")
    previous_gone = 0.0
    for i, cue in enumerate(cues):
        start, end = float(cue["start"]), float(cue["end"])
        following = float(cues[i + 1]["start"]) if i + 1 < len(cues) else None
        appear = max(start - LEAD, previous_gone)
        gone = end + HOLD if following is None else min(end + HOLD, max(following - LEAD, end))
        gone = max(gone, end)
        previous_gone = gone
        lead = f"{{\\k{round((start - appear) * 100)}}}" if start > appear else ""
        size = "{\\fs50}" if len(cue["text"]) > LONG_LINE else ""
        events.append(
            f"Dialogue: 1,{ass_time(appear)},{ass_time(gone)},Current,,0,0,0,,"
            f"{{\\pos({WIDTH // 2},{HEIGHT // 2 - 60})}}{size}{lead}{karaoke_text(cue, start)}"
        )
        if following is not None:
            events.append(
                f"Dialogue: 0,{ass_time(appear)},{ass_time(gone)},Next,,0,0,0,,"
                f"{{\\pos({WIDTH // 2},{HEIGHT // 2 + 130})}}{_clean(cues[i + 1]['text'])}"
            )
    return HEADER + "\n".join(events) + "\n"


def output_key(video_id: str, pitch: int) -> str:
    return f"cache/{video_id}/karaoke{'' if pitch == 0 else f'_p{pitch:+d}'}.mp4"


_rubberband: bool | None = None


def has_rubberband() -> bool:
    """Does ffmpeg have the rubberband filter (the best quality key change)? The Windows and Linux builds do; the static macOS
    ones do not. If ffmpeg does not even run here, assume it does (the real error shows up when exporting). The answer is cached."""
    global _rubberband
    if _rubberband is None:
        try:
            out = subprocess.run(["ffmpeg", "-hide_banner", "-filters"], capture_output=True, text=True, timeout=30).stdout
            _rubberband = bool(re.search(r"\brubberband\b", out))
        except (OSError, subprocess.SubprocessError):
            _rubberband = True
    return _rubberband


def pitch_filter(pitch: int, rubberband: bool | None = None) -> list[str]:
    """The ffmpeg audio filter that changes the key without changing the duration (the lyrics stay in time).

    With rubberband it is rubberband's filter; without it (macOS's ffmpeg) the classic change applies: it changes the sample rate
    (the pitch rises or falls along with the speed) and atempo restores the speed. It sounds a bit less natural, but it does for
    the karaoke video.
    """
    if not pitch:
        return []
    factor = 2 ** (pitch / 12)
    if rubberband if rubberband is not None else has_rubberband():
        return ["-af", f"rubberband=pitch={factor:.6f}"]
    # the input is normalized to 44.1 kHz first: asetrate needs to know the source rate; atempo accepts 0.5 to 100 (±12 semitones fit)
    return ["-af", f"aresample=44100,asetrate={round(44100 * factor)},aresample=44100,atempo={1 / factor:.6f}"]


def ffmpeg_command(ass: Path, audio: Path, out: Path, pitch: int, title: str, artist: str | None) -> list[str]:
    # the `ass` filter parses the path: '/' and ':' must be escaped
    ass_arg = str(ass).replace("\\", "/").replace(":", "\\:")
    return [
        "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
        "-f", "lavfi", "-i", f"color=c=0x0f0f1a:s={WIDTH}x{HEIGHT}:r={FPS}",
        "-i", str(audio),
        "-vf", f"ass={ass_arg}", *pitch_filter(pitch),
        "-c:v", "libx264", "-preset", "veryfast", "-tune", "stillimage", "-crf", "26", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart",
        "-metadata", f"title={title}", *(["-metadata", f"artist={artist}"] if artist else []),
        str(out),
    ]


def export_mp4(storage: LocalStorage, video_id: str, pitch: int = 0, timeout: int = FFMPEG_TIMEOUT) -> str:
    """Makes the MP4 in storage and returns its key. Fails if the song is not ready or ffmpeg fails."""
    base = f"cache/{video_id}"
    if not all(storage.exists(f"{base}/{name}") for name in ("instrumental.mp3", "lyrics.json", "meta.json")):
        raise FileNotFoundError("a música ainda não está pronta")
    meta = json.loads(storage.read(f"{base}/meta.json"))
    cues = json.loads(storage.read(f"{base}/lyrics.json"))
    title = meta.get("title") or video_id
    artist = meta.get("artist")
    with tempfile.TemporaryDirectory(prefix=f"singalong-export-{video_id}-") as tmp:
        work = Path(tmp)
        audio = work / "instrumental.mp3"
        audio.write_bytes(storage.read(f"{base}/instrumental.mp3"))
        ass = work / "lyrics.ass"
        ass.write_text(build_ass(cues, title, artist, float(meta.get("duration") or 0)), encoding="utf-8")
        out = work / "karaoke.mp4"
        result = subprocess.run(ffmpeg_command(ass, audio, out, pitch, title, artist), capture_output=True, text=True, timeout=timeout)
        if result.returncode != 0 or not out.exists():
            raise RuntimeError(f"ffmpeg falhou: {result.stderr.strip()[-400:]}")
        key = output_key(video_id, pitch)
        storage.put(key, out)
    return key


def serve(backend, storage: LocalStorage, stop: threading.Event) -> None:
    """The export thread's loop: answers the API's requests one at a time until `stop` is set."""
    while not stop.is_set():
        try:
            request = backend.next_export(2)
            if not request:
                continue
            video_id, pitch = str(request["video_id"]), int(request.get("pitch", 0))
            backend.set_export_state(video_id, pitch, "processing")
            started = time.monotonic()
            try:
                export_mp4(storage, video_id, pitch)
                backend.publish_song(video_id)  # local storage: the catalog gains the key that was just exported
                backend.set_export_state(video_id, pitch, "ready")
                log.info("MP4 pronto", extra={"job": video_id, "pitch": pitch, "elapsed_s": round(time.monotonic() - started, 1)})
            except Exception as exc:  # noqa: BLE001 - o pedido termina com uma mensagem, nunca fica "processando"
                log.exception("MP4 falhou", extra={"job": video_id, "pitch": pitch})
                backend.set_export_state(video_id, pitch, "failed", str(exc)[:300])
        except Exception:  # noqa: BLE001 - conexão ou pedido inválido: segue para o próximo
            log.warning("falha ao atender pedido de exportação", exc_info=True)
            stop.wait(2)
