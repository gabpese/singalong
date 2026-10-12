# Singalong — Product Requirements Document (PRD)

**English** · [Português (Brasil)](PRD.pt-BR.md)

Version 0.1 · Oct 2026 · Product owner: Gabriel Pesegoginski · Companion technical document: [TRD.md](TRD.md)

## 1. Vision

A **self-hosted, collaborative karaoke**: any YouTube song becomes, in minutes, a karaoke version (instrumental, word-by-word synced lyrics, key change, backing vocals, microphone pitch scoring), with a **queue shared on everyone's phone** and the **TV as the player**. No subscription, no closed catalog, no ads.

## 2. Problem

- Karaoke apps have a closed, paid catalog; the song the group wants is almost never there.
- Making the instrumental and the synced lyrics by hand is laborious.
- At a party, one person controls the computer and the queue turns into chaos (who sings when? who monopolizes?).
- Singing outside your own vocal range is no fun; changing the key normally means reprocessing the song.

## 3. Who uses it (personas)

| Persona | What they want | Where |
|---|---|---|
| **Host** | Set up the party, control the queue, keep it fair | Phone + the computer on the TV |
| **Singer/guest** | Pick the song, adjust the key to their voice, see when to sing | Phone (joins through the QR code) |
| **Library owner** | Have the processed songs available anywhere, at no cost | Home and friends' homes |
| **Future installer user (regular user)** | Install and use it without knowing Docker, Python or the command line | Windows first |

## 4. Goals and non-goals

**Goals**
1. Turn a YouTube link/search into karaoke in as few steps as possible.
2. A fair, collaborative queue, with the next song always pre-processed.
3. Work **from any computer, without the owner's PC on**, for songs that are already ready (free hosting).
4. Be **installable without technical knowledge** and process new songs on the user's computer (local agent).
5. **Zero operating cost** for the owner (free resources only).

**Non-goals (for now)**
- Background video, a commercial catalog, paid accounts, a native phone app, interface localization (the interface is in Brazilian Portuguese).
- Hosting third parties' music as a public service (see legal risks, section 9).

## 5. Functional requirements

Status: ✅ done · 🔧 planned · 💡 idea.

### 5.1 Rooms and queue
| ID | Requirement | Status |
|---|---|---|
| F1 | Create a room with a code and QR code; the TV opens as the player and phones join through the QR | ✅ |
| F2 | Per-room queue with add, remove, reorder, skip, pause/resume and drag the position (host) | ✅ |
| F3 | Optional fair rotation (the same person never sings twice in a row) and "yield your turn" | ✅ |
| F4 | A host link to control the room from another device | ✅ |
| F5 | The next song is always pre-processed; if it is not ready, the next ready one plays and the delayed one keeps its place | ✅ |

### 5.2 Adding songs
| ID | Requirement | Status |
|---|---|---|
| F6 | Search YouTube by artist, title or both, with a video preview; or paste the link | ✅ |
| F7 | Lyrics: the video's manual subtitles, LRCLIB, pasted text (aligned by AI), `.lrc/.srt` or **no lyrics** | ✅ |
| F8 | Jukebox: suggest versions that are already ready before searching YouTube | ✅ |
| F9 | A library with an artist/title filter, sorted alphabetically | ✅ |
| F10 | Process new songs **without the owner's PC on and without YouTube blocking** (local agent) | 🔧 |

### 5.3 Playback
| ID | Requirement | Status |
|---|---|---|
| F11 | Synced lyrics with word-by-word fill and a gap warning (intro/solo) | ✅ |
| F12 | Key change from −6 to +6 semitones per song, live, on the instrumental only | ✅ |
| F13 | The song's key is detected and shown as a note | ✅ |
| F14 | Backing vocals level (0–100%) per song | ✅ |
| F15 | Lyrics offset adjustment by the host | ✅ |
| F16 | Phone preview of the instrumental in the chosen key | ✅ |

### 5.4 Scoring and export
| ID | Requirement | Status |
|---|---|---|
| F17 | Pitch scoring from the microphone, turned on by the host, with a scoreboard | ✅ |
| F18 | Export a karaoke MP4 (with key choice) to sing offline | ✅ |

### 5.5 Hosting and installation
| ID | Requirement | Status |
|---|---|---|
| F19 | Free hosting with HTTPS (Oracle Always Free + Caddy + DuckDNS) | ✅ |
| F20 | CI/CD on GitHub Actions with a multi-architecture image | ✅ |
| F21 | A Windows **installer** that installs the local agent (download, vocal separation, alignment) without Docker | 🔧 |
| F22 | The installer detects the graphics card and uses the NVIDIA GPU when possible; otherwise, it uses the CPU | 🔧 |
| F23 | Pairing the agent with the server through a code, with no password and no file editing | 🔧 |
| F24 | YouTube is accessed through the user's own internet, **without cookies by default**; their browser's cookies only as a fallback, and they never leave the computer | 🔧 |
| F25 | Automatic updates of the agent and of yt-dlp | 🔧 |
| F26 | Choose, per song, whether it stays only on the user's computer or also goes to the cloud | 🔧 |
| F27 | macOS and Linux versions; AMD/Apple GPU | 💡 |

## 6. Non-functional requirements

| Area | Requirement |
|---|---|
| **Cost** | Run the cloud on free resources only; nothing that can trigger an automatic charge |
| **Performance** | Lyrics and audio never drift (the player's local clock); change the key without a noticeable cut; with an NVIDIA GPU, separate a 4-minute song in seconds (measured: ~8 s on an RTX 3060) |
| **Hardware compatibility** | Work on any 64-bit Windows 10/11 PC; the GPU is an optional acceleration, never a requirement |
| **Security and privacy** | Cookies and songs only on the user's computer (unless explicitly chosen); the server has no third-party logins; revocable tokens; no telemetry by default |
| **Context security** | HTTPS is mandatory in the cloud (key change and the microphone need a secure context) |
| **Robustness** | YouTube failures become clear messages; retries only for transient failures; a job that crashes the worker does not loop |
| **Installation** | Install and start using it within 15 minutes, without a terminal; the large download (the AI engine) shows a progress bar |
| **Maintenance** | yt-dlp breaks often: automatic updates and a recoverable error |

## 7. Success metrics

- Time between requesting a new song and it playing (target with GPU: < 2 min; with CPU: < 10 min — to be validated).
- Success rate of downloads by the local agent (target: > 95% without cookies on a residential IP — to be validated).
- Installs completed without help (target: > 90% in a test with 5 people).
- Monthly cloud cost: US$ 0.00.

## 8. Release scope

- **v1 (done):** everything from F1 to F20, running with Docker on the owner's PC and/or on the free VM (library copied over only).
- **v2 (next):** a local agent + a Windows installer (F10, F21 to F26), with the cloud as the central server.
- **v3:** macOS/Linux, AMD/Apple GPU, accounts and several libraries (F27).

## 9. Risks and constraints

- **Copyright and YouTube's terms.** Downloading and separating protected music may violate YouTube's terms and copyright. The project is for personal, private use. Distributing an installer to third parties that downloads from YouTube increases the project's exposure: decide before publicizing it (see open questions).
- **YouTube blocks datacenter IPs** and changes often; that is why the download happens on the user's computer.
- **Varied hardware:** very new cards or other vendors' cards may lack acceleration; the CPU fallback is mandatory.
- **Code signing:** without a certificate, Windows shows an "unknown app" warning; paid certificates go against the zero-cost rule.
- **Storage:** the local library grows (measured: ~16 MB per song on the PC, with the isolated vocals; ~7 MB in the cloud, without them); the AI engine takes a few GB.

## 10. Open questions

1. **Who owns a library?** A single owner per server (the server is personal), or several people, each with their own agent?
2. **Where do the files live?** Only on the user's PC (the TV must be on it or on the same network), or also in the cloud, to play anywhere? (see TRD, section 5)
3. **Will it be distributed publicly?** It changes the stance on copyright and the kind of code signing.
4. **Platforms:** Windows only in the first version?
5. **Name and identity** of the installer and the agent.
