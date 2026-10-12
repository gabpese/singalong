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
3. Work **from any computer, without the owner's PC on**, for songs that are already ready (free hosting; that is what v1 does). In v2 with local storage, the owner's PC must be on until the hybrid mode exists.
4. Be **installable without technical knowledge** and process new songs on the user's computer (local agent), in a **session with a YouTube account** chosen at the start.
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
| F32 | **Import an audio file of the user's own** (mp3, flac, wav, m4a, ogg, opus): the app separates the voice, finds/aligns the lyrics and leaves the song ready, **without going through YouTube** | 🔧 |
| F33 | **Paste the link of an open source** from a fixed list (SoundCloud, Bandcamp, Internet Archive; more later) when the song allows download | 🔧 |

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
| F23 | Automatic updates of the agent and of yt-dlp | 🔧 |
| F24 | **Local storage**: the songs live in a folder on the user's computer and the player reads straight from it | 🔧 |
| F25 | Choose, per song, whether it also goes to the cloud (**hybrid mode**, planned after local) | 💡 |
| F26 | macOS and Linux versions; AMD/Apple GPU | 💡 |

### 5.6 Session and YouTube account (decided)
| ID | Requirement | Status |
|---|---|---|
| F27 | The user **starts a session** in the software and **signs in to YouTube right at the start**; a session has **a single account**, chosen by them | 🔧 |
| F28 | Every room created in the session uses **that same account** to download. When someone requests a song from their phone, **the session owner downloads it**, the owner of the session that phone is connected to, with the defined defaults | 🔧 |
| F29 | The login is asked **before** any download (we do not try, fail and only then ask), and the app shows whether the account is connected. Downloads try **without cookies first** and use the login only when YouTube blocks (an "always use" option in settings) | 🔧 |
| F30 | The account's cookies **stay only on the owner's computer**, never going to the cloud or to the guests | 🔧 |
| F31 | If the session owner is offline, the room says "the session owner is disconnected" and the request waits in the queue | 🔧 |

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
- **v2 (next):** a local agent + an installer **for Windows only**, with a session and YouTube account and **local storage** (F10, F21 to F24, F27 to F33), with the cloud as the central server (rooms, queue, phones).
- **v2.1:** hybrid mode, "take to the cloud" per song (F25).
- **v3:** macOS/Linux, AMD/Apple GPU (F26).

## 9. Risks and constraints

- **Copyright and YouTube's terms.** Downloading and separating protected music may violate YouTube's terms and copyright. The project is for personal, private use. Distributing an installer to third parties that downloads from YouTube would increase the project's exposure; so **the installer will not be publicly distributed** (decided).
- **YouTube blocks datacenter IPs** and changes often; that is why the download happens on the user's computer.
- **Risk to the YouTube account.** yt-dlp itself warns that using an account with it can get the account restricted or banned, and there are reports of IP blocks tied to using cookies. Since the account is only used when YouTube blocks (the default), the risk is lower, but it exists: the recommendation at sign-in is to use a **secondary account just for this**.
- **The login cannot happen in a window embedded in the app.** Google blocks sign-in in embedded browsers (Electron and similar: "This browser or app may not be secure"). The login happens in the user's **regular browser**, and the app reads the session from it. YouTube's cookies rotate often; the app must detect an expired session and ask for the login again.
- **Varied hardware:** very new cards or other vendors' cards may lack acceleration; the CPU fallback is mandatory.
- **Code signing:** the installer **will not be signed** (zero cost and private distribution); whoever receives it sees the Windows warning ("More info → Run anyway").
- **Storage:** the local library grows (measured: ~16 MB per song on the PC, with the isolated vocals; ~7 MB in the cloud, without them); the AI engine takes a few GB.

## 10. Open questions

**Decided (Oct 2026):** the download account is **one per session**, asked at the start, and applies to every room in the session; storage is **local first** (hybrid later); the first version is **Windows only**; downloads try **without cookies first**; **importing the user's own files and links from open sources enters v2** (F32, F33); **only the session owner imports files, through the app** (guests do not upload from the phone); **the app does not verify the origin of an imported file**, and that responsibility lies with whoever imports it (personal use), stated in the terms of use; **the session shows guests only a nickname**, chosen by the owner who signed in at the start (never the YouTube account); **the TV runs on the owner's computer**, where the microphones will be; **the phone is used to** join rooms, pick songs, change the key of the chosen song, yield a turn in the queue and raise or lower the backing vocals (no instrumental preview on the phone in v2); **the installer will not be publicly distributed**, only for the owner and people close to them, with no code signing; **for now the installer will not be published or hosted: it stays only on the owner's machine**, and it is named **`singalong_karaoke.exe`**; the **AI engine is assembled on the user's computer**, downloading each component from its official source.

There are no open product questions. Chrome's and Edge's local network prompt was tested and works with the TV on the owner's computer (TRD, section 5); v2 targets Chrome/Edge.

**No means of testing at the moment:** NVIDIA RTX 50 GPUs and other vendors' GPUs. The installer tests the GPU and falls back to the CPU if it fails, but that was **not validated** on those cards.
