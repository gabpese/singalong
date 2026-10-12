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
- **What the cloud knows about the account:** only a **display nickname**, chosen by the owner when starting the session (it is what guests see), and whether the session is "connected". Never cookies, email or password.
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
| `POST /heartbeat` | Agent version, detected hardware, local queue; the web page shows "agent connected"; the answer carries the `update` notice (section 7) |
| `GET /version?current=X` | Open (no token): `ok`, `update_available` or `update_required`, with the latest/minimum versions, a note and the download link |
| `DELETE /devices/:id` | The owner revokes a device |

On the agent side the code change is small: `runner.process` is already independent of the Redis client. We add a `JobBackend` interface with two implementations (`RedisBackend`, the current one, and `HttpBackend`, new). Redis keeps existing on the server and in the Docker development mode.

## 5. Storage: where the files live (decided: local first; hybrid later)

**Decision (Oct 2026):** v2 uses **mode A, local only**; mode C (hybrid) is planned afterwards (v2.1). The table below shows the three options and why in that order.

The idea of keeping everything on the user's computer and having the player read the local file runs into a browser limitation:

- The karaoke page comes from **`https://singalong…`** and the file is at `http://…` on the agent's computer. Browsers with the *Local Network Access* permission ([source](https://developer.chrome.com/blog/local-network-access)) ask the user to accept it before the page talks to the local machine.
- **Tested in Oct 2026 (installed Chrome 155 and Edge 155, plus Playwright's Chromium), from the real public page:**
  - **Without the permission**, the request never reaches the local server. With the Chrome window visible it stays **pending**: Chrome shows the prompt and waits for the user; with no window (automation), it is blocked.
  - **With the permission**, everything the player uses works, at `http://127.0.0.1`, `http://localhost` and even a **local network address** (`http://192.168.x.x`): `fetch` of the lyrics and melody, `<audio crossOrigin="anonymous">`, Web Audio (`createMediaElementSource`), play and seek (`Range` requests). Browsers no longer treat the local-network address as blocked mixed content.
  - **The private-network preflight (`Access-Control-Allow-Private-Network`) was never requested:** in current Chrome the permission replaces it. **CORS** headers (`Access-Control-Allow-Origin` with the exact origin, `Vary: Origin`, `Expose-Headers` for `Content-Range`/`Accept-Ranges`) and `Range` support are still required.
  - **Not tested:** Firefox and Safari (including iPhone's, which does not follow this model). That is why the instrumental preview on the phone stays out of v2.
- **Decision (M1):** the local media server listens on `127.0.0.1` and the TV runs on the owner's computer. The first time, Chrome asks whether the page may access "devices on the local network": the app shows a simple step explaining to tap **Allow** (the choice is remembered for the site). Since the local-network address also works with the permission, a TV **on another Chromium device on the same network** is a future option, with no change to the design.
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

- **Installer** (Windows, NSIS or MSI through `electron-builder`): small (~100 MB), per-user install (no administrator) into `%LOCALAPPDATA%`. **The file is named `singalong_karaoke.exe`** (set in `electron-builder`, `artifactName`). **For now it is not published or hosted**: it stays only on the owner's machine. If it is ever shared, use a **private link** (Releases of a public repository are public, so they do not qualify).
- **Engine pack** (downloaded on first run, with a progress bar, resumable, with a **SHA-256 checksum**): embedded Python (python-build-standalone) + torch (cpu **or** cu121) + dependencies + `ffmpeg` + `yt-dlp` + `deno` (required by yt-dlp to solve YouTube's challenges). **Decided: assembled on the user's computer.** The installer downloads each component from its **official source** (PyTorch, yt-dlp, ffmpeg, deno, python-build-standalone), in **pinned versions and checksums**, instead of us hosting and redistributing a multi-GB pack. That way we neither pay for nor maintain hosting of the pack, and the license obligations (ffmpeg's GPL) get simpler. Trade-off: it depends on the official sources being up (mitigated by pinned versions, checksums and retries).
- **Updates:** the agent (auto-update) and **yt-dlp** (checked at every start; it is what breaks most) update themselves, with a minimum version required by the server (`/heartbeat` answers "update").
- **Versions and update notice (decided):** the app has a single version number (`MAJOR.MINOR.PATCH`) that the installer, the shell and the agent all read. At every start the agent sends its version to the server (`/agent/v1/version`), which answers the **latest** version, the **minimum** it still accepts, and a short change note. Newer exists → the app shows "update available" with the note; below the minimum → it asks to update before processing (the server also refuses jobs for it). So a new installation is not needed for every change: the shell downloads the new installer (`electron-updater`, from the private link in section 7) and the engine pack is only re-assembled when its pinned components change. The latest/minimum numbers live on the server (a file/variable the owner edits), so publishing a fix is: build, upload to the private link, raise `latest`.
- **Code signing:** since the installer **will not be publicly distributed** and the cost is zero, **we do not sign**. The few people who receive it will see Windows' (SmartScreen) warning and choose "More info → Run anyway"; the installation guide explains this.
- **ffmpeg ships inside the engine pack** (the user installs nothing and the app **does not depend** on an ffmpeg they may already have). It is used by: yt-dlp (extracting the audio), vocal separation (reading and writing audio, MP3 through `libmp3lame`), alignment and key/melody analysis (decoding audio) and the **MP4 export** (`libx264`, `aac`, the `rubberband` filter for the key and `libass` to burn in the lyrics). It sits in the app's folder, **off the PATH**, and the engine calls it by full path. Size: ~80 to 190 MB, depending on the build.
- **Which build:** since we need `libx264`, `libass` and `rubberband`, the build must be **GPL** (LGPL lacks them). Use a prebuilt GPL build for Windows (gyan.dev or BtbN on GitHub, both free), **pin the version and SHA-256** and check when assembling the pack that it contains those codecs and filters (`ffmpeg -encoders`, `-filters`). Running as a **separate program** (not linked to our code), ffmpeg stays GPL and our code keeps its own license; we must include the license notice and a link to the source code. If we ever want to avoid the GPL, the alternative is an LGPL build with OpenH264 or the hardware encoder (losing `rubberband` and `libass`, which would force changing how we do the key change and the subtitles).
- **Licenses:** yt-dlp (Unlicense), Demucs (MIT), model weights have their own licenses: **review them one by one** before redistributing.

## 8. YouTube download and the session login

**Decision (Oct 2026):** the YouTube login is asked **at the start of the session**, before any download, so we never try, fail and only then ask. The chosen account downloads for **all** rooms in the session (section 3.1).

**Login-use policy (decided after a test):** the agent downloads **without cookies first**, through the user's residential internet, and uses the login **only when YouTube blocks** (asks for a login or answers 403). In a test on the owner's PC, without cookies, yt-dlp 2026.08.19 resolved 6 of 6 videos and downloaded 3 of 3 with the default client (there was one isolated 403; it is intermittent). So the login is **ready from the start** (interrupting nobody), but the account stays barely exposed. It can be changed in settings to "always use the login".

**Login flow ("Sign in to YouTube")**
1. The app opens the user's **default browser** at YouTube's sign-in page. It **cannot be a window embedded in the app:** Google **blocks sign-in in embedded browsers**, Electron included ("This browser or app may not be secure"; [Google's policy](https://www.bleepingcomputer.com/news/security/google-to-block-logins-from-embedded-browser-frameworks), [guide on Electron](https://www.todesktop.com/docs/application/google-oauth-screen)).
2. The user signs in (or is already signed in) and, in the app, **picks the browser and profile** where they did it.
3. The agent uses yt-dlp's native **`--cookies-from-browser`** to read that browser's session. Google OAuth **does not work**: it gives an API token, not the session cookie yt-dlp uses.
4. **Validation:** the app makes a request that only works when logged in (to be defined and tested in M1) and shows "Connected" or asks to try again. Only then can the session download.
5. **Expired session:** YouTube's cookies rotate often (especially with YouTube tabs open). The agent validates before every job and, if it expired, warns the owner ("sign in again") and the job waits. One approach cited on yt-dlp's wiki is to export the cookies from an **incognito window** that is never opened again.

**Cautions and limitations**
- **Risk to the account.** yt-dlp warns that using an account with it can get it restricted or banned, and recommends a low request rate and, if possible, a throwaway account ([yt-dlp wiki](https://lab.trianta.dev/mirrors/yt-dlp.yt-dlp/wiki/Extractors)); there are also reports of IP blocks tied to cookies ([Pinchflat](https://github.com/kieraneglin/pinchflat/wiki/YouTube-Cookies)). **Recommendation at sign-in: use a secondary account.** The agent limits the rate (one download at a time, with a pause between them).
- **Setting:** "use the login: **only when YouTube asks** (default) or **always**". Both require the login done at the start. "Always" raises the risk to the account.
- Recent Chrome/Edge on Windows **encrypt cookies in a way yt-dlp often cannot read** (even when not admin); **Firefox** usually works. The alternative is for the user to export a `cookies.txt`. The app must **test the reading** on the login screen and say which browser worked.
- Opening a Chromium with Playwright just for the login is **not necessary** and also runs into Google's protections against automation: it adds ~150 MB without being more reliable than reading the browser the user already has.

**Fixed rules of the agent**
- **Cookies never leave the computer**: the server has no route to receive them; the agent does not log them.
- **Validation on the agent**: the `video_id` must match `^[A-Za-z0-9_-]{11}$`; the agent builds the canonical URL and **accepts only options from a fixed list**. A compromised server cannot send arbitrary flags to yt-dlp (command execution).
- YouTube errors stay translated (`errors.py`), with "Tentar de novo" (try again) only when worth it.

### 8.1 Sources without YouTube: the user's file and open sources (v2)

The pipeline only needs **an audio file**; downloading is just the first step. So a job gets a source type: `source: youtube | file | open_url`.

- **`file` (F32):** the owner picks the file through the **operating system's file picker** in the app (the server never supplies a path). The agent **copies** the file (does not move it) into the library, validates it with `ffprobe` (an audio format, a duration within the current 900 s limit, a maximum size, e.g. 200 MB) and continues from **vocal separation**, skipping the download. Formats: mp3, flac, wav, m4a, ogg, opus.
- **Identifier:** today the id is YouTube's `video_id` (11 characters). Files use `f-` + the first 12 hexadecimal characters of the **SHA-256 of the content**, which also **avoids duplicating** the same file. The id validation in the API and the worker accepts both formats (regex `^[A-Za-z0-9_-]{11}$` or `^f-[0-9a-f]{12}$`), and the rest (`storage`, MP3, `lyrics.json`, `meta.json`) does not change.
- **Metadata:** `source.json` keeps the title/artist read from the file's tags (if any); as today, **artist and title are confirmed and required** before looking up the lyrics.
- **`open_url` (F33):** the owner pastes a link; the agent only accepts **hosts from a fixed list** (SoundCloud, Bandcamp, Internet Archive; more later), downloads with yt-dlp **without cookies** and follows the same path as the file. The server never sends an arbitrary host to the agent (the same rule as section 8). It only works when the author allows downloads; the app shows the site's error when it does not.
- **Who imports:** in v2, **only the session owner, through the app**. A guest does not upload a file from the phone (it avoids large uploads and third parties' files passing through the cloud). Guests keep requesting songs from the library and from YouTube.
- **Copyright:** the app does not verify the file's origin; responsibility lies with whoever imports (personal use), which should appear in the terms of use.
- **Tests:** a unit test of the pipeline from a short synthetic WAV (no network), id validation (`f-…`), rejection of an invalid format/size/duration and of a host outside the list.

## 9. Agent interface

System tray + a simple window: **Pair** (8-character code, once), **Start session / Sign in to YouTube** (pick the browser and profile, with the "Connected" test), **status** (connected, processing, queue, the session's rooms), **library folder**, **detected hardware** (GPU/CPU, a "use CPU" button), **use of the login** (only when YouTube asks, default / always), **logs**, **start with Windows**, **version and update**. No telemetry.

## 10. Security

- A long device token, stored in the OS vault; revocable; valid only for its owner. The server rate-limits and size-limits every agent route.
- TLS is mandatory; no inbound ports on the user's computer.
- Upload (`PUT /library`): an allowed-names list, a size limit, `..` blocking, atomic writes.
- No secrets in the installer; the repository stays **without music** (`storage/` ignored); the installer is delivered through a private link and the engine is downloaded from the official sources, so none of it goes to the public Releases.
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
| **M0 ✅** | `JobBackend` + the `/agent/v1` API + **sessions and per-session job routing** + a fake agent in the tests | The full flow passes with the current worker switched to HTTP; a room's job is only claimed by its session's agent |
| **M1 (M1a ✅, M1b ✅, M1c ✅)** | A "headless" agent (command line) with the engine through Docker/venv, **YouTube login through the browser (`--cookies-from-browser`), a local media server and the `file`/`open_url` source (an `import` command)** | Downloads and processes from the cloud on a PC with a residential IP; the login is validated; Chrome's/Edge's local network prompt was already **tested** (section 5) and a local song plays on the TV from the local media server |
| **M2 ✅** | Engine pack (CPU and cu121) + hardware probe | Installs without Python/Docker; GPU tested with a fallback |
| **M3 ✅** | Electron shell: session, "Sign in to YouTube" screen, an "Import file" button, tray, library folder, logs | A layperson starts the session, signs in to YouTube and processes a song without a terminal |
| **M4** | **Windows** installer + auto-update | A clean install on a VM; update tested |
| **M5** | Hybrid mode ("Take to the cloud") (v2.1) | A published song plays on another computer |
| **M6** | macOS/Linux, AMD/Apple GPU | v3 |

### 12.1 M0: what was done and what changed from the plan (Oct 2026)

**Done.** The worker talks to a `Backend` (`backend.py`): `RedisBackend` (the classic worker, with no change in behavior) and `HttpBackend` (the local agent, over outbound HTTP). The API gained `/agent/v1` (pairing, devices, sessions, session rooms, jobs, search and export), per-session routing and the room's `owner` state. New tests: API (25 in memory and 11 with a real Redis, wired into the CI), worker (31) and end to end with a fake agent in Playwright (3). Also verified with the Node API, Redis and the Python worker over HTTP, from pairing to the ready song, the search and the MP4 (14 of 14 checks).

**What changed or was decided along the way**
- **Pairing without a screen for now:** the code is generated by the administrator (`ADMIN_TOKEN` + `POST /agent/v1/pair/start`) and the agent trades it for a token with `--pair`. The web screen for this stays for M3.
- **The room says where a request comes from through the `X-Room` header** (search, lyrics change and export were not "of the room"). The front-end sends the room code; without it (or in a room without a session) the classic worker applies.
- **A job's state stays keyed by `video_id`** (a single `job:<id>` in Redis). If two owners request the same song at the same time, the second waits for the first (dedupe). In M0 storage is still a shared folder; per-session libraries will come with local storage (M1).
- **A request stuck with an owner who vanished:** if another owner requests the same song and the first one has no signal, the old request is released (failure "the owner left") and the stale message is discarded when the old owner comes back. With the owner online, the request stays with them.
- **`claim` from the same agent returns what stayed with it first** (that is how an agent that restarted resumes the job; the attempt count goes up). So the agent only calls `claim` when idle. A job with no signal for 30 min goes to another agent of the same session.
- **Resuming the session (`resume_id`):** an agent that restarts continues the same session (rooms and requests carry on); without it, the old session is ended and its pending requests become the failure "the owner left".
- **Fastify drops extra body fields** (it does not reject them); so the server accepts only a fixed list of fields on each agent route.

**Left for the next milestones:** the local media server, the YouTube login, the `file`/`open_url` source (M1); the pairing screen and the "owner is disconnected" notice in the interface (M3).

### 12.2 M1a: local storage (Oct 2026)

M1 was split into three parts: **M1a** (local storage: the local media server and the catalog), **M1b** (downloading without cookies first and the YouTube login through the browser) and **M1c** (importing files and open sources). M1a is done.

**Done**
- **Agent:** `media_server.py` (a server on `127.0.0.1`, with a random token in the path, only a fixed list of files, CORS only for the page's origin, `Range`, `HEAD`/`OPTIONS`, `?download=` to download MP4s) and `catalog.py` (the `meta.json` and which files exist). `HttpBackend` sends the `media_base` when starting the session and on the heartbeat and publishes the catalog (`PUT /agent/v1/library`) at start, on every ready song, on every backing-vocals analysis and on every MP4; a network failure does not kill the job (the next heartbeat retries).
- **API:** an `agent_songs` table (the catalog belongs to the **device**, not the session: it survives restarts), `sessions.media_base` (local machine or private network only, `http`, no credentials or query), and the song service describes the song, the library and the MP4s from the owner's catalog when the room has local storage. `f-<12 hex>` identifiers (imported files) are already accepted.
- **Front-end:** the room state carries `local_media`; the TV checks access to the local server (which also triggers the browser's prompt) and guides the user if blocked; the phone does not offer the instrumental preview for local songs; downloading an MP4 from another origin uses `?download=`.
- **Tests:** API (13 for the catalog), agent (19 for the media server and the catalog and 8 for publishing, 147 in total for the worker), front-end (4 unit and 4 end to end in Chrome, with a media server on another origin). Also verified across languages (API with empty storage + Redis + agent): the room becomes ready through the catalog, the browser reads the audio with CORS and `Range`, another site gets 403, the isolated voice 404, and after restarting the agent the song is still ready with the new address. In Docker, with the real library, Chrome played a song on the TV from the container.

**Decisions and lessons**
- **The catalog belongs to the device:** whoever starts a new session already finds the library; only the media address (and the token) changes on each agent run.
- **The media address is validated on the server**, because it reaches everyone's browser in the room: a compromised agent cannot point them at an arbitrary site.
- **The token in the path** protects against another page or program on the same computer; CORS (only the page's origin) against other sites; the fixed list of files keeps the isolated voice and `source.json` inside the computer.
- **Docker is for development only:** the media server listens on `0.0.0.0` inside the container (`AGENT_MEDIA_HOST`), the port is published and the address the browser uses comes from `AGENT_MEDIA_PUBLIC`.
- **Limits:** the instrumental preview on the phone does not exist for local songs; a local song's MP4 only downloads on the owner's computer (the phone cannot reach the local server); Firefox and Safari were not tested.

**Left for M1b and M1c:** downloading without cookies first and the YouTube login through the browser; the `import` command (file and open sources).

### 12.3 M1b: downloading without cookies first and the YouTube login (Oct 2026)

**Measured on this machine (Windows, Chrome 155 and Edge 155 installed)**
- **`--cookies-from-browser` is not fit as the main path:** with Chrome open the cookie database is locked ("Could not copy Chrome cookie database") and with Edge reading fails ("Failed to decrypt with DPAPI"), because of Chromium's cookie encryption. Firefox would work, but it was not installed.
- **The debugging protocol hands over the cookies decrypted:** opening Chrome and Edge with a dedicated profile and a debugging port, `Storage.getCookies` returns the account's cookies without going through the encryption. It is the basis of the login.
- **The validation request:** the "Watch later" playlist (`WL`) only exists for a logged-in account. Without cookies YouTube answers "The playlist does not exist"; with a valid cookie it returns the playlist.
- **Without cookies first works from the home IP:** 3 of 3 real downloads in the worker image, with the `cookies.txt` available, did not use the account even once.

**Done**
- **Cookie policy** (`cookies.py`): `YTDLP_COOKIES_POLICY` = `when-asked` (default), `always` or `never`. Download and search try without cookies and, if YouTube asks for a login (a "not a bot" check, an age gate or a 403), retry with the account. Failures the account does not fix (a private or removed video, the network) go up without spending it. A new error, `forbidden` (403), is retried on its own.
- **Cookie sources**, in order: `YTDLP_COOKIES` (a file), `YTDLP_COOKIES_BROWSER` (yt-dlp; fits Firefox) and the agent's own login.
- **Login through the browser** (`youtube_login.py`, `--youtube-login [chrome|edge]`): opens the installed Chrome or Edge with a **dedicated profile**, waits for the login, reads the cookies through the debugging protocol (a `websockets` client), keeps only the YouTube and Google ones and closes the browser. `--youtube-status` validates with the request above.
- **Tests:** 42 new in the worker (policy, sources, the `cookies.txt` format, the login flow with a fake browser and with a real WebSocket server). Verified with the **real Chrome and Edge**: login detected, only YouTube/Google cookies kept, browser closed, dedicated profile created, validation with an invalid session.

**Decisions and lessons**
- **The login is not asked on every download:** the account is **ready** (login done once) and only enters when YouTube asks. It is the decision to reduce the risk to the account.
- **The profile is dedicated to the agent:** the user's personal profile is not touched, and closing the browser after exporting keeps YouTube from rotating the exported cookies.
- **Two defects found by the tests:** the domain filter accepted names that only *end* the same (`notyoutube.com`, `evilgoogle.com`), which would keep another site's cookie; and the browser choice did not fall back to the other one when the preferred one does not exist. Both were fixed.
- **Tested with a real Google account (by the owner, in Chrome 155, Oct 2026):** Google **accepted** the login in the window opened with the debugging port, the agent kept 48 cookies and the validation answered "Connected". If Google ever refuses that login, the alternative is Firefox (`YTDLP_COOKIES_BROWSER=firefox`) or a `cookies.txt` exported from an incognito window. Not tested: Edge with a real account and the lifetime of the exported cookies (weeks?), which only use will show.

### 12.4 M1c: importing files and open-source links (Oct 2026)

**Done**
- **`--import FILE --artist A --title T`** (`importer.py`): accepts mp3, flac, wav, m4a, ogg and opus; validates with ffprobe/ffmpeg (a text disguised as mp3 is refused), limits `IMPORT_MAX_MB` (200) and 900 s. The id is `f-` + 12 hex of the SHA-256 of the audio, so the same content under another name is the same song and re-importing is instant. Artist/title come from the tags or the flags.
- **`--import-url LINK`**: only SoundCloud, Bandcamp and Internet Archive (exact domain or subdomain), no cookies, single tracks only (playlists, albums and searches are excluded). A YouTube link is refused before any download.
- With `AGENT_URL`/`AGENT_TOKEN` set, the song is published to the agent's catalog and shows up in the room library. The API never creates a YouTube job for an `f-` id (`song_not_found`), and lyrics of an imported song change by re-importing (409 `imported_lyrics`).
- **Tests:** 38+ new in the worker, 2 in the API; cross-language run 18/18 (CLI import, catalog, guest queues it, local media server serves it, unknown `f-` id refused, no job created).

**Measured and lessons**
- Real validation in the worker image: 6 formats read by the real ffprobe, real Demucs import in 20 to 31 s for a 12 s clip, a real Internet Archive item imported.
- yt-dlp's `allowed_extractors` matches the extractor **IE_NAME** (`archive.org`, `Bandcamp`), not its key; the first version failed against a real link and a contract test against yt-dlp's own list now guards it.
- `check_disk` crashed when the library folder did not exist yet (a fresh install); it now measures the nearest existing parent folder.
- Imported originals are not copied into the library, only the derived files. The "Import file" button is part of M3.

### 12.5 M2: version notice, hardware probe and engine pack (Oct 2026)

**Done**
- **Version and update notice:** one number (`singalong_worker/version.py`). `GET /agent/v1/version?current=X` (open, usable before pairing) and the `update` field of the `/heartbeat` answer say `ok`, `update_available` or `update_required`, with the latest and minimum versions, a note and the download link; the server reads them from `APP_LATEST_VERSION`, `APP_MIN_VERSION`, `APP_NOTES` and `APP_DOWNLOAD_URL`. Below the minimum, the server answers jobs with `426`; the agent treats it as a temporary failure (it waits and logs) and resumes alone after the update. CLI: `--version`, `--check-update`.
- **Hardware probe** (`hardware.py`, standard library only): `--hardware` reads `nvidia-smi` (name, driver, memory, compute capability) and recommends `cu121` or `cpu` with the reason: driver below 527.41, a card without kernels in torch 2.5.1/cu121 (Kepler, **Blackwell/RTX 50**) or under 3 GB of memory go to the CPU. `--hardware --selftest` runs a small convolution on the GPU. The summary (engine, cores, RAM, GPU) goes in the heartbeat.
- **Engine pack** (`apps/engine`, Node without dependencies, to be called by the Electron shell): `manifest.json` pins Python 3.11 (python-build-standalone), ffmpeg 8.1 **GPL** (BtbN) and deno, each with its official URL and **SHA-256**; torch 2.5.1 and the other packages come from pip (the PyTorch index `cpu` or `cu121`). `assemble` downloads with resume and a mandatory hash, extracts with Windows' own `tar.exe`, copies the worker, asks the probe for the engine, installs, runs the GPU self-test and, if it fails, **swaps only torch for the CPU build** and records why. Every finished step is saved in `engine.json`, so a closed app or a dropped connection continues where it stopped; a changed manifest redoes only what changed. `verify` checks ffmpeg (GPL, `libx264`, `aac`, `libmp3lame`, `rubberband`, `subtitles`), ffprobe, deno and the Python imports. The worker runs with `launchEnv`: the engine's ffmpeg and deno are in the PATH **of that process only**.
- **Tests:** 27 in the worker (version, hardware with fake `nvidia-smi` and torch), 5 in the API, 19 in the engine (download against a real HTTP server: resume, dropped connection, wrong hash, 404; assembly with fakes: order, CPU/GPU choice, fallback, resume, tampered download), also run on a Windows runner in CI.

**Measured on this machine (Windows 11, RTX 3060, driver 617.42; from an empty folder, no Docker or system Python)**
- The probe chose `cu121`; the real self-test passed. The same self-test inside the Docker image passed with the GPU and failed gracefully ("torch does not see a CUDA GPU") without it.
- The `cu121` engine takes **5.6 GB** (plus ~0.26 GB of cached downloads that can be deleted); all 7 `verify` checks passed.
- A real song went through the pack alone (import, Demucs on the GPU, melody, key): 1 min 18 s the first time, which includes downloading the Demucs weights.

**Bugs found by running it for real**
- A `tar` from Git/MSYS in the PATH reads `D:\folder` as a remote machine: the engine now calls Windows' `System32\tar.exe`.
- The component file name arrived URL-encoded (`%2B`) and had to be decoded.
- The Dockerfile's pip conflict messages about `audio-separator` (installed with `--no-deps` on purpose) also appear here and are harmless.

**Decisions**
- **yt-dlp comes from pip, not as an `.exe`**: the worker imports it as a library and updating it is a `pip install -U` at start. No separate yt-dlp binary in the pack.
- **ffmpeg is pinned to a dated BtbN build.** BtbN removes old builds after a while: if the URL stops working, `manifest.json` takes a newer URL and SHA-256 (the test only checks the format, not the network). The alternative is to host that one file ourselves.
- pip packages are pinned by version, not by hash; signing the lock file with hashes can come with the installer (M4).
- The Blackwell cards (RTX 50) use the CPU until the engine moves to a newer torch/CUDA.

**Left for M3/M4:** the shell that calls `assemble` with a progress bar and the "update available" screen; the installer; a clean-VM test.

### 12.6 M3: the owner's app, Electron interface (Oct 2026)

**Done** (`apps/desktop`)
- **Controller without Electron** (`src/controller.js`): keeps the configuration (`config.json` in the user's data folder), builds the engine (calls `apps/engine` and shows the progress), pairs (`/pair/complete`), starts and stops the **agent** (the worker in service mode, as a child process, restarted if it falls, not restarted if the server refuses the token), polls `/me` to know when the session is online, and runs the worker's commands: create room, YouTube login/check, import file, hardware. The window never receives the token.
- **Window** (`ui/`, plain HTML/JS, strict CSP, no HTML built from outside text): **prepare the computer** (GPU or CPU choice, progress bar, retry), **connect to the server** (address, code, computer name), then the **home**: the update banner (with the note and download link), the session (nickname that guests see, start/end), rooms (create; "Open the TV" and "Open as host" in the browser), **"Import file…"**, YouTube (status and login, browser choice), settings (start with Windows, hardware, unpair) and the log.
- **Shell** (`src/main.js`, `preload.cjs`): context isolation and sandbox on; the window only gets a fixed list of actions; the browser only opens addresses of the paired server or of the update link; a tray icon (closing the window with a running session only hides it; "Quit" ends the session first); a single instance.
- **Tests:** 19 of the controller (a stub server and a fake worker as real processes: pairing, engine, agent restart, room, YouTube, import, unpair, token never in the snapshot) and **1 end to end with the real stack**: Electron + the real API + the real worker (pairing with a wrong and then a right code, update banner, nickname, session online, room seen by the server as "Dona Flor", a non-audio file refused with a readable message, hardware, end of session). In CI the unit tests run on Linux and Windows and the window test on Windows.

**Bugs found by the end-to-end test**
- The controller sent `content-type: application/json` on a `DELETE` with no body and Fastify refused it: **the session was never ended on the server** (the earlier unit test used a stub that accepted it). Fixed (only sets the header when there is a body).
- Ending the session before killing the process let the worker's heartbeat open **another** session; the order is now: note the session, stop the process, end the session.
- `ELECTRON_RUN_AS_NODE=1` (exported by VS Code) makes Electron run as plain Node; the test removes it. Playwright's own Electron mode does not handle an ESM `main`, so the window test starts Electron directly and controls it by the debugging protocol.

**Decisions and what is left**
- The token is stored in `config.json` in the user's profile folder (private to the Windows account); protecting it with the system's encryption (`safeStorage`) can come with the installer.
- The library folder is fixed (`<data>/library`) for now; choosing another folder is left for later.
- The pairing code is still generated by the server administrator (`ADMIN_TOKEN`); a friendlier way to pair without asking for a code stays for v2.
- Not tested on a clean machine: that is the job of M4.

## 13. Decisions made and open questions

**Decided (Oct 2026)**
1. The download account is **one per session**, asked at the start, and applies to every room in the session (sections 3.1 and 8).
2. **Local storage first** (mode A); hybrid later (M5).
3. First platform: **Windows only**.
4. Downloads use the login **only when YouTube blocks** (no cookies first); "always" is an option.
5. **ffmpeg (a GPL build)** ships inside the engine pack (section 7).
6. **Importing the user's files and links from open sources enters v2** (section 8.1).
7. **Only the session owner imports files**, through the app; a guest does not upload a file from the phone.
8. The app **does not verify the origin** of an imported file: responsibility lies with whoever imports it (personal use), and this appears in the terms of use.
9. Guests see only a **nickname** chosen by the owner at the start of the session, never the YouTube account.
10. **The TV runs on the owner's computer** (where the microphones are). The phone: join rooms, pick songs, change the key of the chosen song, yield a turn and adjust the backing vocals; **no instrumental preview on the phone** in v2.
11. The installer **will not be publicly distributed** (only for the owner and people close to them) and **will not be signed**.
12. The installer is named **`singalong_karaoke.exe`** and, **for now, is not published or hosted** (it stays only on the owner's machine).
13. The **engine pack is assembled on the user's computer**, from the official sources, with pinned versions and checksums (section 7).

**Open**
1. **Firefox and Safari** with the TV on the owner's computer: not tested (Chrome's and Edge's local network prompt was tested and works; section 5). v2 targets Chrome/Edge.

**No means of testing at the moment:** RTX 50 (Blackwell) and other vendors' GPUs. The current torch (2.5.1/cu121) probably does not support the RTX 50; the installer tests the GPU and falls back to the CPU, but that was **not validated** on those cards. Raising the torch version would force a review of Demucs, today pinned to 2.5.1.
