"""Parsers de SRT/VTT/LRC e busca no LRCLIB. Saída normalizada: [{start, end, text}] em segundos."""
import json
import re
import urllib.parse
import urllib.request

_TS = r"(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})"
_CUE_RE = re.compile(rf"{_TS}\s*-->\s*{_TS}")
_LRC_RE = re.compile(r"\[(\d+):(\d{2})(?:[.:](\d{1,3}))?\]")
_TAG_RE = re.compile(r"<[^>]+>")

LRCLIB_URL = "https://lrclib.net/api"
USER_AGENT = "singalong/0.1"


def _secs(h, m, s, frac) -> float:
    return int(h or 0) * 3600 + int(m) * 60 + int(s) + int(frac.ljust(3, "0")) / 1000


def parse_cues(text: str) -> list[dict]:
    """Parser comum para SRT e VTT."""
    cues = []
    for block in re.split(r"\n\s*\n", text.replace("\r\n", "\n").strip()):
        lines = block.split("\n")
        for i, line in enumerate(lines):
            m = _CUE_RE.search(line)
            if m:
                g = m.groups()
                body = " ".join(_TAG_RE.sub("", l).strip() for l in lines[i + 1 :]).strip()
                if body:
                    cues.append({"start": _secs(*g[0:4]), "end": _secs(*g[4:8]), "text": body})
                break
    return _dedupe(cues)


def _dedupe(cues: list[dict]) -> list[dict]:
    """Une repetições consecutivas (comuns em VTT rolante do YouTube)."""
    out: list[dict] = []
    for cue in sorted(cues, key=lambda c: c["start"]):
        if out and out[-1]["text"] == cue["text"] and cue["start"] <= out[-1]["end"] + 0.05:
            out[-1]["end"] = max(out[-1]["end"], cue["end"])
        else:
            out.append(cue)
    return out


def parse_lrc(text: str) -> list[dict]:
    entries = []
    for line in text.replace("\r\n", "\n").split("\n"):
        stamps = list(_LRC_RE.finditer(line))
        if not stamps:
            continue
        body = line[stamps[-1].end() :].strip()
        for m in stamps:
            mm, ss, frac = m.groups()
            entries.append({"start": int(mm) * 60 + int(ss) + int((frac or "0").ljust(3, "0")) / 1000, "text": body})
    entries.sort(key=lambda e: e["start"])
    cues = []
    for i, e in enumerate(entries):
        if not e["text"]:
            continue
        nxt = entries[i + 1]["start"] if i + 1 < len(entries) else e["start"] + 5.0
        cues.append({"start": e["start"], "end": nxt, "text": e["text"]})
    return cues


def parse_lyrics_file(text: str) -> list[dict]:
    """Detecta o formato (SRT/VTT ou LRC) pelo conteúdo."""
    if _CUE_RE.search(text):
        return parse_cues(text)
    cues = parse_lrc(text)
    if not cues:
        raise ValueError("formato de letra não reconhecido (esperado SRT, VTT ou LRC com tempos)")
    return cues


def search_lrclib(artist: str, title: str, duration: float | None, tolerance: float = 5.0) -> list[dict]:
    """Candidatos com letra sincronizada. Filtra por duração quando conhecida."""
    params = {"track_name": title, "artist_name": artist}
    req = urllib.request.Request(
        f"{LRCLIB_URL}/search?{urllib.parse.urlencode(params)}", headers={"User-Agent": USER_AGENT}
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        results = json.load(resp)
    ok = [r for r in results if r.get("syncedLyrics")]
    if duration:
        ok = [r for r in ok if r.get("duration") and abs(r["duration"] - duration) <= tolerance]
        ok.sort(key=lambda r: abs(r["duration"] - duration))
    return ok


def apply_text(text: str, timed: list[dict]) -> list[dict]:
    """Usa o texto do usuário (uma linha por verso, sem tempos) com os tempos de uma letra sincronizada.

    Exige o mesmo número de linhas: sem isso o casamento linha a linha seria um chute.
    """
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if len(lines) != len(timed):
        raise ValueError(
            f"o texto tem {len(lines)} linhas e a fonte de tempos tem {len(timed)}; "
            "ajuste o texto para ter o mesmo número de linhas"
        )
    return [{"start": c["start"], "end": c["end"], "text": line} for line, c in zip(lines, timed)]
