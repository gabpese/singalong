"""SRT/VTT/LRC parsers and the LRCLIB search. Normalized output: [{start, end, text}] in seconds."""
import json
import re
import time
import urllib.error
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
    """A parser shared by SRT and VTT."""
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
    """Merges consecutive repeats (common in YouTube's rolling VTT)."""
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
    """Detects the format (SRT/VTT or LRC) from the content."""
    if _CUE_RE.search(text):
        return parse_cues(text)
    cues = parse_lrc(text)
    if not cues:
        raise ValueError("formato de letra não reconhecido (esperado SRT, VTT ou LRC com tempos)")
    return cues


class LyricsServiceError(Exception):
    """The online lyrics service did not answer (down, slow or an invalid answer)."""


def _fetch_json(req, attempts: int = 3, pause: float = 1.0):
    """A GET with retries on transient failures (5xx, network, timeout); repeating a 4xx is useless."""
    last: Exception | None = None
    for attempt in range(attempts):
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                return json.load(resp)
        except urllib.error.HTTPError as exc:
            last = exc
            if exc.code < 500:
                break
        except (urllib.error.URLError, TimeoutError, OSError, ValueError) as exc:
            last = exc
        if attempt + 1 < attempts:
            time.sleep(pause * (attempt + 1))
    raise LyricsServiceError(str(last)) from last


def search_lrclib(artist: str, title: str, duration: float | None = None) -> list[dict]:
    """Candidates with synced lyrics; with `duration`, the closest durations first."""
    params = {"track_name": title, "artist_name": artist}
    req = urllib.request.Request(
        f"{LRCLIB_URL}/search?{urllib.parse.urlencode(params)}", headers={"User-Agent": USER_AGENT}
    )
    results = _fetch_json(req)
    # any candidate with lyrics (with timings OR text only): the text serves the AI alignment
    found = [r for r in results if (r.get("syncedLyrics") or r.get("plainLyrics")) and r.get("duration")]
    if duration:
        found.sort(key=lambda r: abs(r["duration"] - duration))
    return found


def pick_candidate(candidates: list[dict], duration: float | None, tolerance: float = 5.0, loose: bool = False):
    """Picks, among the candidates WITH TIMINGS, the one with the video's duration (±tolerance s).

    With `loose`, it accepts the closest one even outside the tolerance (the lyrics may be off time).
    Returns (candidate | None, closest | None); the second one explains the refusal.
    """
    synced = [c for c in candidates if c.get("syncedLyrics")]
    if not synced:
        return None, None
    closest = min(synced, key=lambda r: abs(r["duration"] - duration)) if duration else synced[0]
    if not duration or abs(closest["duration"] - duration) <= tolerance or loose:
        return closest, closest
    return None, closest


_LRC_STAMP = re.compile(r"\[\d+:\d{2}(?:[.:]\d{1,3})?\]")


def candidate_text(candidate: dict) -> str:
    """Only a candidate's lyrics text (no timings), one line per verse."""
    plain = (candidate.get("plainLyrics") or "").strip()
    if plain:
        return plain
    lines = (_LRC_STAMP.sub("", ln).strip() for ln in (candidate.get("syncedLyrics") or "").splitlines())
    return "\n".join(ln for ln in lines if ln)


def best_text_candidate(candidates: list[dict], duration: float | None) -> dict | None:
    """The candidate with text whose duration is closest to the video's (the lyrics are the same; only the timings differ)."""
    with_text = [c for c in candidates if candidate_text(c)]
    if not with_text:
        return None
    return min(with_text, key=lambda r: abs(r["duration"] - duration)) if duration else with_text[0]


def apply_text(text: str, timed: list[dict]) -> list[dict]:
    """Uses the user's text (one line per verse, no timings) with the timings of synced lyrics.

    Requires the same number of lines: without that, matching line by line would be a guess.
"""
    lines = [ln.strip() for ln in text.splitlines() if ln.strip()]
    if len(lines) != len(timed):
        raise ValueError(
            f"Sua letra tem {len(lines)} linhas, mas a letra usada como referência de tempo tem {len(timed)}. "
            "Ajuste para o mesmo número de linhas (uma linha por verso)."
        )
    return [{"start": c["start"], "end": c["end"], "text": line} for line, c in zip(lines, timed)]
