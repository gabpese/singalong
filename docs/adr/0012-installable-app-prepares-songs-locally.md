---
status: accepted
date: 2026-10-19
---

# 0012. Songs are prepared on each user's own computer

**English** · [Português (Brasil)](0012-installable-app-prepares-songs-locally.pt-BR.md)

Singalong earns nothing, so the owner did not want to pay for a server powerful enough to separate songs, nor keep their own computer on to process songs for everyone else. Instead, the installable app sets up what preparing a song needs (Python, PyTorch, ffmpeg: the Engine) and each user's own computer prepares their songs. Downloading from the user's home connection also avoids YouTube's block on cloud addresses (measured: 0 of 8 videos from the VM). The app is built with Electron so it reuses the web's TV and host pages, keeping one place to change when the screens change.

## Considered options

- **A paid GPU server**: rejected; it costs money ([ADR 0001](0001-zero-cost-while-non-profit.md)), and YouTube would still block it.
- **The owner's computer prepares everyone's songs**: rejected; it would have to stay on whenever anyone sings.
- **One installer with everything inside**: rejected; several gigabytes per release, and redistributing PyTorch and ffmpeg builds has license weight. The Engine is assembled on first run from the official sources, pinned with SHA-256 checksums.
- **Tauri instead of Electron**: rejected; Electron runs the same Chromium on Windows, macOS and Linux, so the TV's audio and microphone behave the same everywhere, while Tauri brings Rust and uses WebKit outside Windows ([ADR 0016](0016-no-full-stack-framework.md)).

## Consequences

- The first run downloads and assembles the Engine (CPU, or a supported GPU when there is one).
- A Room's new songs depend on its Owner's app being open; songs already prepared keep playing.
