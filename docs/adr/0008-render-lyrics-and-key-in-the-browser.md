---
status: accepted
date: 2026-10-19
---

# 0008. Lyrics and key are drawn in the browser, not baked into a video

**English** · [Português (Brasil)](0008-render-lyrics-and-key-in-the-browser.pt-BR.md)

The expensive part of a karaoke track is separating the voice, and that is done once and kept. The lyrics are timed text the TV draws as the song plays, and the key changes only the instrumental, per song in the Queue, without processing it again. Rendering an MP4 for every song would cost a video encode per song and per key; it exists only as an optional Export.
