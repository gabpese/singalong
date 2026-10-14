"""Exporta a música como vídeo MP4 de karaokê: instrumental + letra que se preenche palavra a palavra.

A letra vira uma legenda ASS (efeito de karaokê \\kf, com os tempos reais de cada palavra quando existem) queimada por
cima de um fundo liso; o tom é trocado, se pedido, com o filtro rubberband do ffmpeg.

O transporte dos pedidos (Redis ou HTTP) está em backend.py; o contrato com a API em apps/api/src/jobs.js.
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
LEAD = 1.5  # a linha aparece 1,5 s antes de ser cantada
HOLD = 0.8  # ...e fica 0,8 s depois
TITLE_SECONDS = 6.0
LONG_LINE = 70  # linhas com mais caracteres que isso usam fonte menor (senão ocupam três linhas e encostam na próxima)
FFMPEG_TIMEOUT = 900

# ASS: cores em &HAABBGGRR. No karaokê o texto vai de SecondaryColour (ainda não cantado) a PrimaryColour (cantado).
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
    """Texto seguro para o ASS: sem chaves (tags), barras nem quebras de linha."""
    return " ".join(text.replace("{", "(").replace("}", ")").replace("\\", "/").split())


def word_times(cue: dict) -> list[tuple[float, float]]:
    """Início e fim de cada palavra da linha: os tempos reais (`words`) ou uma estimativa pelo tamanho de cada palavra."""
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
    """Texto da linha com os tempos de preenchimento (centissegundos) a partir do instante `appear` em que ela aparece."""
    words = _clean(cue["text"]).split()
    times = word_times({**cue, "text": " ".join(words)})
    parts, cursor = [], appear
    for i, (word, (s, _e)) in enumerate(zip(words, times)):
        wait = round((s - cursor) * 100)
        if wait > 0:
            parts.append(f"{{\\k{wait}}}")
            cursor += wait / 100
        # cada palavra se preenche até o início da seguinte (ou até o próprio fim, na última): sem buracos no efeito
        end = times[i + 1][0] if i + 1 < len(words) else times[i][1]
        fill = max(round((end - cursor) * 100), 1)
        cursor += fill / 100
        parts.append(f"{{\\kf{fill}}}{word}{' ' if i < len(words) - 1 else ''}")
    return "".join(parts)


def build_ass(cues: list[dict], title: str, artist: str | None, duration: float) -> str:
    """Legenda ASS: cartão de título no começo, a linha atual em karaokê e a próxima, em cinza, logo abaixo."""
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
    """O ffmpeg tem o filtro rubberband (a troca de tom de melhor qualidade)? Os builds do Windows e do Linux têm; os estáticos do
    macOS não. Se o ffmpeg nem roda aqui, assume que sim (o erro de verdade aparece ao exportar). A resposta é guardada."""
    global _rubberband
    if _rubberband is None:
        try:
            out = subprocess.run(["ffmpeg", "-hide_banner", "-filters"], capture_output=True, text=True, timeout=30).stdout
            _rubberband = bool(re.search(r"\brubberband\b", out))
        except (OSError, subprocess.SubprocessError):
            _rubberband = True
    return _rubberband


def pitch_filter(pitch: int, rubberband: bool | None = None) -> list[str]:
    """Filtro de áudio do ffmpeg para trocar o tom sem mudar a duração (a letra continua no tempo).

    Com o rubberband é o filtro dele; sem ele (ffmpeg do macOS) vale a troca clássica: muda a taxa de amostragem (o tom sobe ou desce
    junto com a velocidade) e o atempo devolve a velocidade. Fica um pouco menos natural, mas serve para o vídeo do karaokê.
    """
    if not pitch:
        return []
    factor = 2 ** (pitch / 12)
    if rubberband if rubberband is not None else has_rubberband():
        return ["-af", f"rubberband=pitch={factor:.6f}"]
    # a entrada é normalizada para 44,1 kHz primeiro: o asetrate precisa saber a taxa de origem; o atempo aceita de 0,5 a 100 (±12 semitons cabem)
    return ["-af", f"aresample=44100,asetrate={round(44100 * factor)},aresample=44100,atempo={1 / factor:.6f}"]


def ffmpeg_command(ass: Path, audio: Path, out: Path, pitch: int, title: str, artist: str | None) -> list[str]:
    # o filtro `ass` interpreta o caminho: precisa de '/' e de ':' escapados
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
    """Gera o MP4 no storage e devolve a chave. Falha se a música não está pronta ou o ffmpeg falha."""
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
    """Loop da thread de exportação: atende pedidos da API um de cada vez enquanto `stop` não for sinalizado."""
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
                backend.publish_song(video_id)  # armazenamento local: o catálogo ganha o tom que acabou de ser exportado
                backend.set_export_state(video_id, pitch, "ready")
                log.info("MP4 pronto", extra={"job": video_id, "pitch": pitch, "elapsed_s": round(time.monotonic() - started, 1)})
            except Exception as exc:  # noqa: BLE001 - o pedido termina com uma mensagem, nunca fica "processando"
                log.exception("MP4 falhou", extra={"job": video_id, "pitch": pitch})
                backend.set_export_state(video_id, pitch, "failed", str(exc)[:300])
        except Exception:  # noqa: BLE001 - conexão ou pedido inválido: segue para o próximo
            log.warning("falha ao atender pedido de exportação", exc_info=True)
            stop.wait(2)
