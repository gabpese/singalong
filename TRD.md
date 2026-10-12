# Singalong — Technical Requirements Document (TRD)

**English** · [Português (Brasil)](TRD.pt-BR.md)

Version 0.1 · Oct 2026 · Complements the [PRD.md](PRD.md) and the [PLAN.md](PLAN.md) (decisions and history). This document describes the **current** architecture (section 2) and the **proposed** local agent with an installer (sections 3 to 10).

## 1. Scope

Make Singalong work in two parts: a central **server** (today, the free Oracle VM) and a **local agent** installed on the user's computer, which downloads from YouTube through their internet and processes the audio. The user installs the agent without Docker, Python or a terminal.

## 2. Current architecture (as built)

```
[Phone]──┐                  ┌─ Fastify API (Node 24) ── SQLite (rooms, queue)
         ├─ HTTPS/WS ───────┤         │
[TV]─────┘      (Caddy)     └─ /media (Range) ── storage/cache/<video_id>/
                                     │
                                  Redis ◄── Python worker (pulls): yt-dlp • Demucs • Whisper • UVR • ffmpeg
```

- **API**: rooms, queue, WebSocket, `/media`, search and jobs through Redis (contract in `apps/api/src/jobs.js`). It never calls the worker; the worker always **pulls** (works behind NAT).
- **Worker**: consumes the `jobs` stream (consumer group), serves `search:req` and `export:req` in dedicated threads and the backing-vocals analysis in another. A job's logic (`runner.py`) does not depend on the Redis client (it receives an object with `hset/hincrby/expire/xack`).
- **Storage**: the `local` driver (the `storage/` folder), logical keys `cache/<id>/{instrumental.mp3, vocals.mp3, lyrics.json, meta.json, melody.json, backing.mp3, source.json}`.
- **Today**: the worker runs in Docker on the owner's PC (`gpu` or `cpu` profile); the cloud only plays the library copied by `deploy/sync-library.sh`, because YouTube blocks the Oracle IP (measured: 0 of 8 downloads without cookies).

## 3. Proposed architecture

```
 Cloud (Oracle, free)                             User's computer
┌──────────────────────────────┐ HTTPS (outbound only)┌────────────────────────────────────┐
│ Caddy → API → SQLite / Redis │◄─────────────────────│ Singalong agent (Electron, tray)   │
│  • rooms, queue, TV, phone   │  claim/progress/     │  └─ Engine (embedded Python)       │
│  • agent API (/agent/v1)     │  complete/upload     │      yt-dlp • ffmpeg • Demucs •    │
│  • cloud library             │                      │      Whisper • UVR   (CPU or NVIDIA)│
└──────────────────────────────┘                      │  Local library (chosen folder)     │
                                                      └────────────────────────────────────┘
```

Principles:
1. **The agent only makes outbound connections** (no open ports, works behind NAT/a router).
2. **The cloud never receives cookies**. The agent also **does not obey arbitrary commands**: the server sends only a `video_id` and options from a closed set (section 8).
3. **The engine reuses the current worker's code**, changing only the transport (Redis → HTTP), with no pipeline rewrite.
4. **The GPU is optional**: the same engine runs on CPU (section 6).
5. **One session = one owner = one YouTube account** (section 3.1). Every song request made from a phone is run by the agent of the room's session owner.

### 3.1 Session, rooms and who downloads (decided)

**Model:** `Session { id, device_id (the owner's agent), YouTube profile, rooms[] }`. The session starts in the owner's app, which **signs in to YouTube before any download** (section 8).

- **Rooms belong to a session** (`rooms.session_id`). The owner creates the room from the app and the browser opens its page already as the host.
- **Phones join the room through the QR code, as today.** When a guest requests a song, the API creates the job and **routes it to the room's session**: only the agent that owns that session can claim it (`claim` filters by `session_id`). The guest never sees or uses the owner's account.
- **Owner offline:** the job stays in the queue and the room shows "the session owner is disconnected" (detected through the `heartbeat`). Songs that are already local keep playing on the owner's own TV.
- **End of session:** when the app is closed, the session ends; rooms follow the current rule (deleted after 24 h idle).
- **What the cloud knows about the account:** only a **display nickname** and whether the session is "connected". Never cookies, email or password.
- **Server:** new tables `sessions(id, device_id, display_name, created_at, last_seen)` and the `rooms.session_id` column; the jobs stream now carries `session_id`.
- **The cloud's role:** with local storage (section 5), the cloud becomes the **meeting point**: rooms, queue, phones, WebSocket and the agent API. It keeps no songs.

## 4. Agent API (new, on the server)

Prefix `/agent/v1`, authenticated by a **device token** (`Authorization: Bearer`). The server remains the only thing that talks to Redis.

| Route | Purpose |
|---|---|
| `POST /sessions` · `DELETE /sessions/:id` | Starts/ends the agent's session (display nickname only, no account data) |
| `POST /pair/start` · `POST /pair/complete` | Pairing: the web page shows an **8-character code (10 min)**; the agent sends it and receives the token (stored in the OS vault: Credential Manager on Windows) |
| `POST /jobs/claim` (long-poll, 25 s) | Delivers the next job `{video_id, lyrics_source, lyrics_text?, artist?, title?}`, with an expiring claim (visibility timeout), like today's `XAUTOCLAIM` |
| `POST /jobs/:id/progress` | `{status, stage, error?, error_code?, retry?}` (the same content as the `job:<id>` hash) |
| `POST /jobs/:id/complete` | Marks `ready` or `needs_lyrics` |
| `PUT /library/:id/:file` | **Hybrid mode only (M5):** uploads an artifact to the cloud when the song is published (section 5); atomic (`.tmp` + rename), size limit, allowed names only |
| `POST /search/claim` · `POST /search/:id/result` | YouTube search done by the agent (replaces `search:req/res`) |
| `POST /exports/claim` · `POST /exports/:id/result` | MP4 export |
| `POST /heartbeat` | Agent version, detected hardware, local queue; the web page shows "agent connected" |
| `DELETE /devices/:id` | The owner revokes a device |

On the agent side the code change is small: `runner.process` is already independent of the Redis client. We add a `JobBackend` interface with two implementations (`RedisBackend`, the current one, and `HttpBackend`, new). Redis keeps existing on the server and in the Docker development mode.

## 5. Storage: where the files live (decided: local first; hybrid later)

**Decision (Oct 2026):** v2 uses **mode A, local only**; mode C (hybrid) is planned afterwards (v2.1). The table below shows the three options and why in that order.

The idea of keeping everything on the user's computer and having the player read the local file runs into a browser limitation:

- The karaoke page comes from **`https://singalong…`**. A browser **blocks** it from loading audio from `http://192.168.x.x` (mixed content and private network access). The exception is `http://localhost`.
- So a **local** song only plays on the **TV running on the agent's own computer** (or connected to it by HDMI). A TV at another house or on another computer **cannot reach** the file.
- **Chrome asks for permission.** Chrome has a *Local Network Access* permission: a public page that reaches `localhost` or the local network may trigger a prompt the user must accept ([source](https://developer.chrome.com/blog/local-network-access)). Confirmed details are missing (the version where it became the default, WebSocket and iframes): **test in M1** and, if it gets in the way, serve the TV page from the agent itself at `http://localhost`.
- **The agent's local server** answers at `http://127.0.0.1:<port>/media` with `Range`, CORS for the cloud's origin and `Access-Control-Allow-Private-Network: true`.
- **Limitations of mode A:** the **instrumental preview on the phone** does not work (the phone cannot reach the file); the YouTube video preview still does. The owner's PC must be on to play and to download.
- A song that is **already in the cloud** (today's library, copied with `sync-library.sh`) keeps playing from anywhere until the hybrid exists.

| Mode | How it works | Plays anywhere? | Cost/risk |
|---|---|---|---|
| **A. Local only (v2, decided)** | The agent serves `http://localhost:<port>/media`; the room and the TV run on the same PC | No | Zero; no third-party files in the cloud |
| **B. Cloud** | The agent uploads the files to the VM (`PUT /library`); the player reads from the cloud | **Yes** | VM disk (45 GB free; ~7 MB/song) and protected files on a server |
| **C. Hybrid (v2.1)** | A song always stays in the local library; **publishing to the cloud is optional, per song** ("Take to the cloud") | Only the published ones | The user's choice; the server only keeps what was published |

The "go to my brother's house" case **requires mode B/C** for the songs you want to bring along. In every mode, **scoring, key change and backing vocals** keep working, since they depend only on the files and the player.

## 6. Hardware and acceleration (question: "does it only work with my card?")

**It is not tied to a model.** The code picks the device automatically (`DEMUCS_DEVICE` empty = automatic; so does the alignment's Whisper). What exists is **one image for CPU and another for NVIDIA**, chosen through `TORCH_INDEX` (`cpu` or `cu121`, torch 2.5.1). The result today:

| Hardware | Current support | Notes |
|---|---|---|
| **NVIDIA** (GTX 900 up to RTX 40) | ✅ GPU (CUDA 12.1) | Measured on the RTX 3060: a 3:42 track separated in ~8 s |
| **NVIDIA RTX 50 (Blackwell)** | ⚠️ To verify | torch 2.5.1/cu121 probably **has no kernels** for that architecture (it needs newer builds, CUDA 12.8). The installer must **test** the GPU and fall back to CPU if it fails |
| **AMD / Intel (GPU)** | ❌ uses the CPU | ROCm on Windows is limited; DirectML stays as an idea (F27) |
| **Apple Silicon** | ❌ uses the CPU (future: MPS) | Demucs supports MPS; left for v3 |
| **CPU only** | ✅ | Slower: separation takes minutes per song; the backing vocals (onnxruntime) already run on **CPU only** today (~1 to 1.5 min/song) |

Proposed minimum requirements (**to be measured** with real tests before publishing): Windows 10/11 64-bit, 8 GB of RAM, 4 cores, ~10 GB free (AI engine + models: Demucs ~80 MB, Whisper `small` ~460 MB, UVR ~53 MB; torch alone takes a few GB).

**Hardware probe (in the installer and on every update):** detect an NVIDIA GPU (driver ≥ what CUDA 12.1 requires) → install the `cu121` engine → run a **real test** (a small convolution on the GPU). If it fails, install/use the `cpu` engine and warn. The user can force the CPU in settings.

## 7. Packaging and installer

**Proposed decision: an Electron shell + an "engine pack" downloaded on first run.**

| Option | Pros | Cons | Verdict |
|---|---|---|---|
| **Electron** (shell) | The stack is already JS/TS/React; tray, auto-update (`electron-updater`), `child_process` for the engine | ~100 MB base | **Chosen** |
| Tauri | Very light | Needs Rust; the lightness disappears next to a few GB of torch | Alternative |
| Plain Node SEA/`pkg` | Small | Does not solve Python/torch; no interface | Only for a "headless" mode |
| PyInstaller of everything | A single `.exe` | Torch + CUDA is huge and fragile | Discarded |
| Docker for the user | Already works | WSL2 + Docker Desktop: heavy and confusing for a layperson | Discarded |

- **Installer** (Windows, NSIS or MSI through `electron-builder`): small (~100 MB), per-user install (no administrator) into `%LOCALAPPDATA%`.
- **Engine pack** (downloaded on first run, with a progress bar, resumable, with a **SHA-256 checksum**): embedded Python (python-build-standalone) + torch (cpu **or** cu121) + dependencies + `ffmpeg` + `yt-dlp` + `deno` (required by yt-dlp to solve YouTube's challenges). Hosted on **GitHub Releases** (free).
- **Updates:** the agent (auto-update) and **yt-dlp** (checked at every start; it is what breaks most) update themselves, with a minimum version required by the server (`/heartbeat` answers "update").
- **Code signing:** without a certificate, Windows (SmartScreen) warns. Free paths: SignPath Foundation (open source projects) or accepting the warning at first. A paid certificate goes against the zero-cost rule.
- **Licenses:** yt-dlp (Unlicense), ffmpeg (use an LGPL build, no GPL), Demucs (MIT), model weights have their own licenses: **review them one by one** before redistributing.

## 8. YouTube download and the session login

**Decision (Oct 2026):** the YouTube login is asked **at the start of the session**, before any download, so we never try, fail and only then ask. The chosen account downloads for **all** rooms in the session (section 3.1).

**Login flow ("Sign in to YouTube")**
1. The app opens the user's **default browser** at YouTube's sign-in page. It **cannot be a window embedded in the app:** Google **blocks sign-in in embedded browsers**, Electron included ("This browser or app may not be secure"; [Google's policy](https://www.bleepingcomputer.com/news/security/google-to-block-logins-from-embedded-browser-frameworks), [guide on Electron](https://www.todesktop.com/docs/application/google-oauth-screen)).
2. The user signs in (or is already signed in) and, in the app, **picks the browser and profile** where they did it.
3. The agent uses yt-dlp's native **`--cookies-from-browser`** to read that browser's session. Google OAuth **does not work**: it gives an API token, not the session cookie yt-dlp uses.
4. **Validation:** the app makes a request that only works when logged in (to be defined and tested in M1) and shows "Connected" or asks to try again. Only then can the session download.
5. **Expired session:** YouTube's cookies rotate often (especially with YouTube tabs open). The agent validates before every job and, if it expired, warns the owner ("sign in again") and the job waits. One approach cited on yt-dlp's wiki is to export the cookies from an **incognito window** that is never opened again.

**Cautions and limitations**
- **Risk to the account.** yt-dlp warns that using an account with it can get it restricted or banned, and recommends a low request rate and, if possible, a throwaway account ([yt-dlp wiki](https://lab.trianta.dev/mirrors/yt-dlp.yt-dlp/wiki/Extractors)); there are also reports of IP blocks tied to cookies ([Pinchflat](https://github.com/kieraneglin/pinchflat/wiki/YouTube-Cookies)). **Recommendation at sign-in: use a secondary account.** The agent limits the rate (one download at a time, with a pause between them).
- **An option to reduce the risk:** in settings, "use the login: **always** (default, as decided) or **only when YouTube asks**" (no cookies first, through the residential internet, and with cookies only on a login error). Both require the login done at the start.
- Recent Chrome/Edge on Windows **encrypt cookies in a way yt-dlp often cannot read** (even when not admin); **Firefox** usually works. The alternative is for the user to export a `cookies.txt`. The app must **test the reading** on the login screen and say which browser worked.
- Opening a Chromium with Playwright just for the login is **not necessary** and also runs into Google's protections against automation: it adds ~150 MB without being more reliable than reading the browser the user already has.

**Fixed rules of the agent**
- **Cookies never leave the computer**: the server has no route to receive them; the agent does not log them.
- **Validation on the agent**: the `video_id` must match `^[A-Za-z0-9_-]{11}$`; the agent builds the canonical URL and **accepts only options from a fixed list**. A compromised server cannot send arbitrary flags to yt-dlp (command execution).
- YouTube errors stay translated (`errors.py`), with "Tentar de novo" (try again) only when worth it.

## 9. Agent interface

System tray + a simple window: **Pair** (8-character code, once), **Start session / Sign in to YouTube** (pick the browser and profile, with the "Connected" test), **status** (connected, processing, queue, the session's rooms), **library folder**, **detected hardware** (GPU/CPU, a "use CPU" button), **use of the login** (always / only when YouTube asks), **logs**, **start with Windows**, **version and update**. No telemetry.

## 10. Security

- A long device token, stored in the OS vault; revocable; valid only for its owner. The server rate-limits and size-limits every agent route.
- TLS is mandatory; no inbound ports on the user's computer.
- Upload (`PUT /library`): an allowed-names list, a size limit, `..` blocking, atomic writes.
- No secrets in the installer; the repository stays **without music** (`storage/` ignored); the engine and installer go only to Releases.
- Main threat model: a **compromised server** (it cannot run code on the agent: section 8, item 4) and a **third-party agent** (it cannot read another library's jobs: a token per owner).

## 11. Testing

- **`JobBackend` contract:** the same suite runs against `RedisBackend` and `HttpBackend`.
- **Server:** tests for the `/agent/v1` routes (pairing, claim with expiry, upload with limits and traversal) in the current style (`node:test`).
- **End to end:** a **fake agent** on Playwright's test server (an in-memory job queue already exists) validates requesting a song, watching progress and playing it.
- **Installer:** a matrix of Windows 10/11 VMs without a GPU, with NVIDIA, and without Python/Docker installed; a test of the CPU fallback when the GPU fails.
- **Download:** a scheduled (non-blocking) test with a fixed set of videos to detect yt-dlp breakage.

## 12. Milestones

| Milestone | Deliverable | Definition of done |
|---|---|---|
| **M0** | `JobBackend` + the `/agent/v1` API + **sessions and per-session job routing** + a fake agent in the tests | The full flow passes with the current worker switched to HTTP; a room's job is only claimed by its session's agent |
| **M1** | A "headless" agent (command line) with the engine through Docker/venv, **YouTube login through the browser (`--cookies-from-browser`) and a local media server** | Downloads and processes from the cloud on a PC with a residential IP; the login is validated; Chrome's local network prompt **tested** with the TV on `localhost` |
| **M2** | Engine pack (CPU and cu121) + hardware probe | Installs without Python/Docker; GPU tested with a fallback |
| **M3** | Electron shell: session, "Sign in to YouTube" screen, tray, library folder, logs | A layperson starts the session, signs in to YouTube and processes a song without a terminal |
| **M4** | **Windows** installer + auto-update | A clean install on a VM; update tested |
| **M5** | Hybrid mode ("Take to the cloud") (v2.1) | A published song plays on another computer |
| **M6** | macOS/Linux, AMD/Apple GPU | v3 |

## 13. Decisions made and open questions

**Decided (Oct 2026)**
1. The download account is **one per session**, asked at the start, and applies to every room in the session (sections 3.1 and 8).
2. **Local storage first** (mode A); hybrid later (M5).
3. First platform: **Windows only**.

**Open**
1. **Nickname or real account** shown to guests (showing the real account exposes the owner's identity).
2. **Use of the login:** default "always" with the option "only when YouTube asks"; confirm.
3. Is a **TV on the owner's computer** (and no instrumental preview on the phone) acceptable in v2? Checking Chrome's local network prompt (M1) may force serving the TV page from the agent.
4. **Public distribution?** It defines the stance on copyright, the warning about the account and the code signing.
5. **RTX 50 and others:** confirm on your machine and on a new card whether the current torch works (or raise the torch version, which forces a review of Demucs, today pinned to 2.5.1).
