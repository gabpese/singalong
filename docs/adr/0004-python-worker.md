---
status: accepted
date: 2026-10-19
---

# 0004. The worker is Python

**English** · [Português (Brasil)](0004-python-worker.pt-BR.md)

The tools that make Singalong possible are only mature in Python, on top of PyTorch: Demucs separates the voice, Whisper (through stable-ts) aligns the lyrics to it, and yt-dlp downloads the audio. There is no serious JavaScript equivalent, so no single-language stack, Flutter included, would remove Python from the project.

## Consequences

- The project keeps two languages for good: JavaScript/TypeScript for everything people touch and Python for the audio work.
- The two sides meet only through JSON contracts (a Redis stream and the `/agent/v1` HTTP API), never through shared code.
