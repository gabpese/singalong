# singalong

**English** · [Português (Brasil)](README.pt-BR.md)

A self-hosted, collaborative karaoke system: search for a song on YouTube and Singalong builds the karaoke version (instrumental, word-by-word synced lyrics, key change, backing vocals, microphone pitch scoring and MP4 export), with a shared queue on everyone's phone and a TV as the player.

Full plan and design decisions: [PLAN.md](PLAN.md) ([Português](PLAN.pt-BR.md)).

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
