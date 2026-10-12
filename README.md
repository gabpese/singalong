# singalong

**English** · [Português (Brasil)](README.pt-BR.md)

A self-hosted, collaborative karaoke system: search for a song on YouTube and Singalong builds the karaoke version (instrumental, word-by-word synced lyrics, key change, backing vocals, microphone pitch scoring and MP4 export), with a shared queue on everyone's phone and a TV as the player.

Documentation: [PRD](PRD.md) (product requirements), [TRD](TRD.md) (technical requirements and the installer/agent proposal) and [PLAN](PLAN.md) (design decisions and history). Each one also has a Portuguese version (`*.pt-BR.md`).

> The app's interface is in Brazilian Portuguese. Where this README quotes a button or label, the Portuguese text follows in parentheses.

## Running it

Requirements: Docker (with the NVIDIA Container Toolkit for GPU) and `secrets/youtube_cookies.txt` with your YouTube cookies
(YouTube blocks downloads without a login; the `secrets/` folder is in `.gitignore`).

```powershell
docker compose --profile gpu up -d --build     # API + Redis + GPU worker
# no GPU:  docker compose --profile cpu up -d --build
```

Open **http://localhost:3000** (to use another port, set `$env:API_PORT=3001` before the command).

## How a party works

1. **Create the room** (on the home page). You become the **host** and the **TV** opens in another tab.
2. **The TV** (`tv.html`) is the browser that plays the music: open it on the computer connected to the TV, **through `http://localhost:3000`** (key change needs a secure context: localhost or https). While nothing is playing it shows the room code and a **QR code**.
   If the browser asks, click "Toque aqui para ativar o som" (tap here to enable sound) once.
3. **Phones** join through the QR code or by typing the code, and each person adds their own songs. For the QR code to work on phones, give the computer's network address: `$env:PUBLIC_URL="http://192.168.0.10:3000"` before `docker compose up`.
4. The queue plays by itself. **While one song plays, the next one is already being prepared** (download, vocal separation, finding and aligning the lyrics). If the next song is not ready yet, the following ready one plays and the delayed one keeps its place.

| Who | What they can do |
|---|---|
| Anyone in the room | add songs, remove songs and change the key **of their own** songs, see the queue |
| Host | all of that **on any song**, plus skip, pause/resume, reorder (▲▼), adjust the lyrics and turn on **fair rotation** (the same person never sings twice in a row while someone else is waiting) |

- The **host link** (room's ⋯ menu) lets another device control the room. Whoever has the link is in charge.
- The **TV** shows, at the top, **who is singing now → the next singer** (the same one the server will play: ready and honoring fair rotation), and next to it the **list with the current song and the next 5** ("+ N na fila" for the rest), plus a progress bar.
- **Gap warning:** in lyric gaps of **8 s or more** (intro, solo, bridge) the TV shows `--------------` in place of the current line, with the next lyric already below. In the **last 8 s** the dashes fade away, so the singer can see when the line starts. For lyrics timed only at the start of each line (LRC), a solo sits "inside" the previous line; the app estimates how long the line takes to sing (~0.12 s per letter + 2 s) and treats the rest as a gap.
- **Yield your turn** ("⇩ Ceder a vez"): someone who has to step away (to the bathroom, say) taps it on their own song and it **moves down one position**: the person behind sings first. It can be repeated. Only the host can move a song *up* (otherwise anyone could cut the line).
- The **song's key** is detected automatically and shown only as the **note**, without major/minor (the mode does not change when transposing): "Lá (A)", "Dó♯ / Ré♭ (C#/Db)". When you raise or lower the singing key it shows which note you will sing: "Lá (A) → Si (B) with +2". It is an **estimate**: when the app is not sure it shows both candidates ("Tom provável: Fá (F) ou Ré (D)", meaning "Likely key: F or D").
- The **singing key** (−6 to +6 semitones) is per song in the queue and changes live. The **lyrics offset** applies to the song in any room.
- **Previews on the phone:** when searching, the **▶ Prévia** button (or **Ouvir no YouTube** for a pasted link) plays the original video so you can check it is the right song. With the song already prepared, **▶ Prévia** in the queue plays the **instrumental in the chosen key**, and changing the key there changes the key of your song in the queue. (The instrumental preview works over http through the network IP.)
- The phone has three tabs: **Fila** (queue), **Adicionar** (add) and **Músicas** (already processed songs). The **Músicas** tab has an **artist and title filter**: it ignores case and accents, accepts several words in any order ("elfman jack" finds "Jack's Lament" by Danny Elfman) and shows "3 de 12" (3 of 12). The list is sorted alphabetically by artist; songs without an artist go last.
- Rooms idle for 24 hours are deleted. Reloading the TV in the middle of a song resumes where it was.

### Adding a song

Enter the **Artist** and the **Song title** (both are required). With them the app:

1. **searches YouTube** for `Artist - Song title`: tap **🔎 Buscar no YouTube**, use **▶ Prévia** to listen and pick the right video (if you already have a link, use **Já tenho o link do vídeo**);
2. **looks up the lyrics** with the same two fields (the "Buscar a letra na internet" option, the default).

The lyrics can come from:

| Option on screen | What it does |
|---|---|
| Use the video's subtitles, if it has any | uses YouTube's **manual** subtitles (auto-captions are deliberately ignored) |
| Search the lyrics on the internet | looks the lyrics up on [LRCLIB](https://lrclib.net) by artist + title. If there is a version **with timings and the same duration**, it uses it; otherwise (common for covers) it takes the **text** and the AI syncs it with the voice |
| Paste the lyrics and sync them with the voice (AI) | **the way out for covers and videos with no timing reference**: you paste the lyrics (one line per verse) and the AI (Whisper, in "align text" mode) finds when each line is sung by listening to the isolated vocals. It does not write lyrics |
| Sing without lyrics | instrumental only: **always** works, even when nothing above fits |
| Advanced: lyrics that already have timings | contents of a `.lrc` or `.srt` file |

- Without usable lyrics, the song stays in the queue as **"Precisa de letra"** (needs lyrics) with a **Escolher letra** (choose lyrics) button; the instrumental already processed is reused (only the lyrics are redone).
- For covers and produced videos (with credits, for example) the duration differs from the original version, which is useless as a timing reference: the AI syncs the text with the video's voice (about 1 minute the first time).
- Songs already processed (**Músicas** tab) go into the queue without asking for artist and title.
- **Why don't the lyrics come from Google/Musixmatch?** Google blocks automated access ("unusual traffic" captcha) and Musixmatch's official free API returns only **30% of the lyrics** (the full text needs a paid license). So the text comes from LRCLIB (an open API that has the songs we tested). The text is only the starting point: the AI marks the timings.
- The video's subtitles depend on YouTube allowing their download; when it rate-limits (HTTP 429), the job goes on without them.

Everything is stored in `storage/cache/<video_id>/` (`instrumental.mp3`, `vocals.mp3`, `lyrics.json`, `meta.json` with the key, `source.json`).
Rooms and the queue live in a SQLite database in the Docker volume `api-data`.

### API

| Route | Purpose |
|---|---|
| `POST /api/rooms` | creates the room: `{code, host_token}` |
| `GET /api/rooms/:code` | state: queue, what is playing, `tv_connected`, `me.is_host` |
| `POST /api/rooms/:code/queue` `{url \| video_id, lyrics?, artist?, title?, name?, pitch?}` | adds to the queue (and requests processing right away) |
| `DELETE /api/rooms/:code/queue/:item` · `POST …/move {direction}` · `PATCH …/queue/:item {pitch}` | remove · move (`down` = yield the turn, the owner may; `up` host only) · key |
| `POST /api/rooms/:code/player/{pause,resume,skip}` · `PATCH /api/rooms/:code {fair}` | control (host) |
| `PUT /api/rooms/:code/songs/:id/offset {offset}` | lyrics offset, in seconds (host) |
| `WS /api/rooms/:code/ws?role=tv\|controller` | real-time state; the TV sends `ended` and `position` |
| `GET /api/search?q=` | searches YouTube videos (served by the worker; 10-minute cache) |
| `POST /api/songs` · `GET /api/songs` · `GET /api/songs/:id` · `PUT /api/songs/:id/lyrics` | songs and processing (used by the room) |
| `GET /media/cache/<id>/...` | files, with `Range` support |
| `GET /healthz`, `GET /readyz` | liveness / readiness (checks Redis) |

Requests carry `X-Client-Id` (the browser's id) and, for the host, `X-Host-Token`.
The contract between the API and the worker (Redis Streams) is documented in [apps/api/src/jobs.js](apps/api/src/jobs.js).

### Local agent (milestone M0: server side and worker transport)

A **local agent** is the worker running on the owner's computer and talking to the server over **outbound HTTP only** (`/agent/v1`), with no Redis access. The owner starts a **session** (with a nickname the guests see), creates the rooms of that session, and every song request made from a guest's phone in those rooms is routed to **that owner's agent** (never to another session's). Design and plan: [TRD](TRD.md).

| Route (`/agent/v1`, `Authorization: Bearer <device token>`) | Purpose |
|---|---|
| `POST /pair/start` (header `X-Admin-Token`) · `POST /pair/complete {code, name}` | pairing: the admin generates an 8-character one-time code (10 min); the agent trades it for a device token |
| `GET /me` · `DELETE /devices/me` | the device and its active session · revoke this device |
| `POST /sessions {display_name, resume_id?}` · `DELETE /sessions/:id` · `POST /sessions/:id/rooms` | start/resume/end the session · create a room in it |
| `POST /heartbeat` | proof of life (the owner shows as "online" for 45 s) |
| `POST /jobs/claim {wait_ms}` · `POST /jobs/:id/progress` · `POST /jobs/:id/complete` | processing jobs (long-poll, up to 25 s) |
| `POST /search/claim` · `POST /search/:id/result` | YouTube search done by the agent |
| `POST /exports/claim` · `POST /exports/:id/:pitch/state` | MP4 export |

Pages send the room code in `X-Room` so the search, the lyrics change and the export of a room go to its session's agent. The room state carries `owner: {nickname, online}` (and `null` for rooms without a session, which keep using the classic Redis worker).

```bash
# on the server (set ADMIN_TOKEN; without it pairing is off): generate a one-time code
curl -X POST https://YOUR_HOST/agent/v1/pair/start -H "X-Admin-Token: $ADMIN_TOKEN"
# on the owner's computer (the worker package; Python):
python -m singalong_worker --pair CODE --agent-url https://YOUR_HOST          # prints AGENT_TOKEN=...
export AGENT_URL=https://YOUR_HOST AGENT_TOKEN=... AGENT_SESSION_NAME="My nickname"
python -m singalong_worker --consume        # the agent: starts the session and pulls jobs, searches and exports
python -m singalong_worker --create-room    # prints the TV and host links of a new room in the session
```

**Trying the agent by hand with Docker** (PowerShell, from the project root; the interface does not show the owner's nickname or the "owner disconnected" notice yet, only the API does):

```powershell
$env:ADMIN_TOKEN = "any-long-secret"
docker compose up -d --build --wait api redis  # only the API and Redis (no classic worker); --wait returns when the API is ready
# generate the one-time code, trade it for a device token and keep it in $env:AGENT_TOKEN
$resp = curl.exe -s -X POST http://localhost:3000/agent/v1/pair/start -H "X-Admin-Token: $env:ADMIN_TOKEN"; $resp   # {"code":"ABCD2345",...}
$code = ($resp | ConvertFrom-Json).code
$out = docker compose --profile cpu run --rm -T worker --pair $code --agent-url http://api:3000
$env:AGENT_TOKEN = ($out | Select-String '^AGENT_TOKEN=').Line.Split('=', 2)[1].Trim()
echo $env:AGENT_TOKEN   # sga_... (47 characters). $env: only lives in ONE terminal: set it again in each terminal you use below
# terminal 1: the agent (leave it open; use --profile gpu and worker-gpu for speed)
docker compose --profile cpu run --rm -p 8765:8765 -e AGENT_URL=http://api:3000 -e AGENT_TOKEN=$env:AGENT_TOKEN -e AGENT_SESSION_NAME="Gabriel" -e AGENT_MEDIA_HOST=0.0.0.0 -e AGENT_MEDIA_PUBLIC=http://127.0.0.1:8765 -e AGENT_ALLOWED_ORIGINS=http://localhost:3000 worker --consume
# terminal 2: a room in the agent's session (prints the TV and host links)
docker compose --profile cpu run --rm -e AGENT_URL=http://api:3000 -e AGENT_TOKEN=$env:AGENT_TOKEN worker --create-room --agent-url http://api:3000 --public-url http://localhost:3000
```

Then open the TV link, join the room as a guest in another window, search and add a song: the search and the processing happen on the agent. Stop the agent with Ctrl+C and the next search says the owner is disconnected. `curl.exe -H "x-client-id: guest-0001" http://localhost:3000/api/rooms/CODE` shows `owner: {nickname, online}`. When the agent starts it also analyzes the backing vocals of songs already in `storage/` (slow on CPU), as the classic worker does.

**Local storage (milestone M1a).** With the agent, the songs stay **on the owner's computer** (`storage/`). The agent starts a **local media server** (`http://127.0.0.1:8765/<random token>/cache/<id>/<file>`, only an allow-list of files: never the isolated voice) and publishes to the server a **catalog** of the ready songs (the `meta.json` and which files exist) when it starts and on every new song, backing-vocals analysis or MP4. The room's songs, library and MP4 links then point to that local server, so the **TV must run on the owner's computer**. Chrome/Edge ask once for the *Local Network Access* permission (the TV shows a hint explaining it); the phone has no instrumental preview for local songs. Tested with Chrome 155 and Edge 155 (Firefox and Safari were not).

| Agent variable | Default | Purpose |
|---|---|---|
| `AGENT_MEDIA_PORT` | `8765` | port of the local media server (the next 9 are tried if it is busy); **`0` turns it off** and the server uses its own storage (the M0 behavior) |
| `AGENT_MEDIA_HOST` | `127.0.0.1` | where it listens; with Docker use `0.0.0.0` and publish the port (`-p 8765:8765`) |
| `AGENT_MEDIA_PUBLIC` | — | the address the **browser** uses when it is not `http://127.0.0.1:<port>` (Docker: `http://127.0.0.1:8765`) |
| `AGENT_ALLOWED_ORIGINS` | the origin of `AGENT_URL` | origins (the cloud page) allowed to read the media, comma separated; with Docker the page is `http://localhost:3000` |

**YouTube login and cookies (milestone M1b).** The worker (the agent and the classic one) downloads **without cookies first**, through your own internet, and uses the YouTube account **only when YouTube asks for a login** (a "not a bot" check, an age gate or a 403): then it retries with the account's cookies. Several downloads in a row from the home IP worked without the account; using an account with yt-dlp can get it restricted, so prefer a **secondary account**.

| Variable | Default | Purpose |
|---|---|---|
| `YTDLP_COOKIES_POLICY` | `when-asked` | `when-asked` (account only when YouTube asks), `always`, or `never` |
| `YTDLP_COOKIES` | — | a `cookies.txt` (Netscape format) to use as the account |
| `YTDLP_COOKIES_BROWSER` | — | read the cookies from a browser through yt-dlp (`firefox`, `chrome:Profile 1`). **On Windows Chrome and Edge do not work** (their cookie encryption blocks yt-dlp); Firefox does |
| `AGENT_DATA_DIR` | `~/.singalong` | where the agent keeps its login (`youtube_cookies.txt` and the browser profile) |

The sources are tried in that order: `YTDLP_COOKIES`, `YTDLP_COOKIES_BROWSER`, then the agent's own login:

```powershell
cd apps\worker                                      # the module lives here
pip install websockets "yt-dlp[default]"            # the only packages the login and the check need
python -m singalong_worker --youtube-login          # opens Chrome or Edge with a profile only for the agent; sign in to the YouTube account
python -m singalong_worker --youtube-login edge     # choose the browser
python -m singalong_worker --youtube-status         # "Connected" / "No valid login" (one request that only works when logged in)
```

`--youtube-login` opens **your installed Chrome or Edge with a dedicated profile** (your personal browser profile is not touched), waits for you to sign in, asks the browser itself for the cookies through its debugging protocol (it hands them over already decrypted, which is why it works where yt-dlp cannot read the browser) and saves only the YouTube and Google cookies to `~/.singalong/youtube_cookies.txt`, then closes the browser. The cookies never leave the computer. If the login in that window is refused, use Firefox with `YTDLP_COOKIES_BROWSER=firefox` or a `cookies.txt` exported from a private window.

**Importing your own songs (milestone M1c).** Besides YouTube, you can bring audio you already have or a link from an open source. It runs on the worker, stays on this computer and goes through the same pipeline (vocal separation, key, lyrics).

```powershell
python -m singalong_worker --import "C:\Music\song.mp3" --artist "Artist" --title "Title" [--lyrics lrclib|align|none]
python -m singalong_worker --import-url "https://archive.org/details/<item>" --artist "Artist" --title "Title"
```

Formats: mp3, flac, wav, m4a, ogg, opus (size up to `IMPORT_MAX_MB`, 200 by default, and 15 minutes). Links: only SoundCloud, Bandcamp and Internet Archive, single tracks, no cookies. Artist and title are read from the tags when you omit them. If `AGENT_URL` and `AGENT_TOKEN` are set, the song is also published to your agent's catalog and shows up in the room library. The app does not verify where a file comes from: import only what you have the right to use.

### Worker CLI (no API, for testing)

```powershell
docker compose --profile gpu run --rm worker-gpu "<link>" --lyrics lrclib
docker compose --profile gpu run --rm worker-gpu "<link>" --lyrics align --lyrics-file /storage/inputs/letra.txt
```

## Robustness (configuration)

Optional variables (in `.env` or the environment; `0` turns the limit off):

| Variable | Default | What it does |
|---|---|---|
| `MAX_DURATION_SECONDS` | 900 | rejects longer videos (before downloading) |
| `MIN_FREE_GB` | 2 | refuses to process when disk space is low |
| `SEPARATE_TIMEOUT_SECONDS` | 900 | maximum time for separation (Demucs) |
| `WORKER_MAX_ATTEMPTS` | 3 | automatic retries, only for transient failures (network, 429) |
| `CACHE_MAX_GB` | 20 | above this, deletes the songs sung longest ago (never those in the queue) |
| `LOG_LEVEL` | info | log level (JSON in Docker) |

YouTube errors become messages in Portuguese; "Tentar de novo" (try again) only shows up when it is worth it (not for a private, blocked or too-long video). There is a per-person request limit (search, queue, create room), `/readyz` details Redis, database and storage, and the worker has a heartbeat healthcheck.

## CI/CD and hosting

- **CI** (`.github/workflows/ci.yml`): on every push and pull request it runs the API tests, the front-end tests (TypeScript, unit, build and end-to-end with Playwright) and the worker tests, and checks that the images build.
- **CD** (`.github/workflows/deploy.yml`): after a green CI on `main`, it publishes the API image to the GitHub Container Registry (amd64 and arm64) and, if enabled, updates the VM over SSH.
- **Free hosting with HTTPS** to open the app from any computer without your PC being on: see [`deploy/README.md`](deploy/README.md) (in Portuguese).

## Tests

```powershell
cd apps/worker; python -I -m unittest discover -s tests -t .
cd apps/api;    npm test
cd apps/web;    npm test            # pure logic (node:test)
cd apps/web;    npm run typecheck   # TypeScript
cd apps/web;    npm run build; npm run e2e   # end-to-end tests (Playwright, against the build in dist/)
```

The end-to-end tests start a test API on their own (`apps/web/e2e/server.mjs`, with ready-made songs and an in-memory job queue) and open a real Chromium with a fake microphone. The first time: `npx playwright install chromium`.

## Front-end development

The front-end is React + TypeScript with Vite, in `apps/web` (pages `index.html`, `room.html` and `tv.html`; code in `src/`). With the API running on `localhost:3000`:

```powershell
cd apps/web; npm install; npm run dev     # http://localhost:5173, with fast reload; /api and /media go to the API
```

The API image builds the front-end (`vite build`) and serves the result; outside Docker, run `npm run build` and the API serves `apps/web/dist`.
