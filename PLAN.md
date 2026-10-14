# Singalong — Development Plan

**English** · [Português (Brasil)](PLAN.pt-BR.md)

A self-hosted karaoke system: paste a YouTube link and the system builds the karaoke version (instrumental + synced lyrics), with key change and a collaborative queue that pre-processes in the background.

## 1. Requirements

| # | Requirement | Decision |
|---|-------------|----------|
| R1 | Input: YouTube link | Extract the `video_id` (11 chars) as the key for everything |
| R2 | Lyrics: use the video's subtitles if present; otherwise a **mandatory choice** of source (no transcription AI in v1) | YouTube subtitles → LRCLIB → paste `.lrc`/text manually |
| R3 | Simple video (just scrolling text) | See decision D1: render the lyrics **in the player**, MP4 is optional |
| R4 | Pitch shift for people who sing "professionally" | Real time in the player, applied **only to the instrumental** |
| R5 | Collaborative queue, next song pre-processed in the background | Rooms + persistent queue + worker consuming jobs |
| R6 | Cache: the same song is not reprocessed | Cache by `video_id` on disk + index in the database |

## 2. Architecture decisions

**D1 — Do not render MP4 by default.** The heavy part (and the one worth caching) is separating the vocals. The scrolling lyrics are just synced text: the TV player plays the `instrumental` + `lyrics.json` and draws the lyrics with `requestAnimationFrame`. Advantages: no FFmpeg step per song, trivial pitch shift (the audio is independent of the video), font/size/color changes without reprocessing. MP4 stays as an optional feature (export).

**D2 — Pitch shift only on the instrumental.** Since the original vocal has already been removed, shifting the instrumental by ±N semitones is what the singer needs. In the browser: `SoundTouchJS` or `Tone.PitchShift` (AudioWorklet), keeping the speed. Suggested range: −6 to +6 semitones. The chosen key is stored per queue item (`pitch`), not in the cache.

**D3 — API in Node.js (Fastify) + Worker in Python (decided).** Fastify (+ Socket.io or `@fastify/websocket`) handles rooms, queue, cache and events; the Python worker handles yt-dlp/Demucs. The two talk through a **simple contract over Redis** (see section 13), not through language-specific queue libraries.

**D4 — State in SQLite at first** (move to Postgres if it becomes multi-server). Redis only for the job queue and event pub/sub.

## 3. Components

```
[ Phone (controller) ]──┐
                        ├─ WebSocket/HTTP ─> [ API (FastAPI) ] ──> SQLite
[ TV / Player ]─────────┘                          │
                                              Redis (jobs)
                                                   │
                                          [ Python worker ]
                                       yt-dlp • demucs • lyrics
                                                   │
                                         /storage/cache/<video_id>/
```

1. **Controller (phone):** join the room (code/QR), paste a link, pick the lyrics source, view/reorder/remove the queue, choose the key.
2. **Player (TV):** waiting screen with QR, plays the current song, draws the lyrics, applies the pitch, reports the end of the song.
3. **API:** rooms, queue, playback state, real-time events, cache lookup, job dispatch.
4. **Worker:** processing pipeline (below).

## 4. Worker pipeline (per `video_id`)

Each step writes its artifact and updates the status; if the artifact already exists, the step is skipped (idempotent, resumable).

1. **Metadata + download** — `yt-dlp`: audio (`bestaudio` → wav/flac), title/artist/duration, and subtitles (`--write-subs --write-auto-subs`? **no**: auto-subs are YouTube's own AI and have poor timing; use only manual subtitles by default, auto-subs as an explicit option).
2. **Separation** — `demucs` (`--two-stems=vocals`, model `htdemucs`) → `instrumental.*` (and optionally `vocals.*` for future scoring). Uses the GPU if there is one; on CPU it takes minutes, so the queue and the cache are essential.
3. **Lyrics** — resolve according to the chosen source:
   - **Video subtitles** (SRT/VTT → normalize).
   - **LRCLIB** (search by artist + title + duration; accept only results with `syncedLyrics`, check the duration difference).
   - **Manual** (the user pastes `.lrc` or plain text; plain text without timing = rejected in v1 or shown unsynced).
   Normalized output: `lyrics.json` = `[{start, end, text}]` (lines; words later).
4. **Finalization** — writes `meta.json` (lyrics source, pipeline version, timestamps) and marks `ready`.

### "Mandatory lyrics" flow
If the video has no subtitles, the job moves to the `needs_lyrics` status. The phone of whoever added it shows the source choice (LRCLIB with a list of candidates / paste LRC). The audio **keeps processing in parallel** — only the lyrics block `ready`.

## 5. Cache

- Key: `video_id`. Structure:
  ```
  storage/cache/<video_id>/
    instrumental.(mp3|flac)
    lyrics.json          # + lyrics.<source>.json if there are variants
    meta.json            # title, artist, duration, lyrics source, pipeline_version
  ```
- Ready = `instrumental` and `lyrics.json` exist (not merely "the folder exists", since interrupted jobs leave a partial folder). Write to `.tmp` and rename at the end.
- **Dedupe of in-flight jobs:** two people asking for the same song at the same time → a single job, both queue items point to it (lock per `video_id`).
- Switching the lyrics source reuses the instrumental (only step 3 is redone).
- `pipeline_version` in `meta.json` to invalidate the cache when the model/parameters change.
- **LRU cleanup:** a `last_played_at` column in the database; a weekly job removes the least recent when a disk limit is exceeded (never remove songs in the current queue).

## 6. Queue and preloading

- Item states: `pending → processing → needs_lyrics → ready → playing → done | failed | skipped`.
- Playback order is independent of processing order: the worker processes in queue order but **prioritizes the next 2–3** items that are not yet `ready`.
- A song is only "playable" when `ready`. If the next item is not ready, the player skips to the next ready one (or waits, configurable) and the delayed item keeps its position.
- Room rules: a host with power to skip/remove; optional "fair rotation" (interleaves by person so nobody monopolizes).
- Real-time events (WebSocket): `queue_updated`, `job_progress`, `now_playing`, `needs_lyrics`.

## 7. Data model (v1)

- `rooms(id, code, created_at)`
- `songs(video_id PK, title, artist, duration, status, lyrics_source, pipeline_version, last_played_at)`
- `queue_items(id, room_id, video_id, added_by, position, pitch, status, created_at)`
- `jobs` stays in Redis; `songs.status` mirrors the result.

## 8. API (sketch)

- `POST /rooms` · `GET /rooms/{code}`
- `POST /rooms/{code}/queue` `{url}` → resolves `video_id`, checks the cache, creates a job if needed
- `PATCH /rooms/{code}/queue/{id}` `{pitch?, position?}` · `DELETE …`
- `POST /rooms/{code}/player/{play|pause|skip}`
- `GET /songs/{video_id}/lyrics/candidates` · `PUT /songs/{video_id}/lyrics` `{source|lrc}`
- `GET /media/{video_id}/instrumental` (with Range support)
- `WS /rooms/{code}/events`

## 9. Stack

| Layer | Choice |
|---|---|
| Front-end (controller + player) | React/Vite (or Svelte) + Web Audio API + SoundTouchJS/Tone.js |
| API | Node.js + Fastify + Socket.io |
| Queue | Redis (Streams or lists; contract in section 13) |
| Database | SQLite → Postgres |
| Worker | Python: yt-dlp, demucs, ffmpeg, SRT/VTT/LRC parser |
| Deploy | Docker Compose (api, worker, redis); worker with optional GPU |

Suggested repository layout:

```
singalong/
  apps/
    api/        # Fastify (src/routes, src/plugins, server.js)
    worker/     # Python: worker.py (consumes the queue), pipeline.py
    web/        # controller + player
  packages/     # shared types (optional)
  storage/      # cache (gitignored)
  docker-compose.yml
```

## 10. Phases

**Phase 0 — Pipeline spike (CLI, no UI).** `python process.py <url>` → downloads, separates, resolves lyrics, writes the cache. Validates Demucs quality, CPU/GPU times and LRCLIB coverage for your repertoire. *Criterion: 5 real songs produce a correct instrumental + lyrics.json.*

**Phase 1 — Standalone player.** A page that plays `instrumental` + `lyrics.json` with synced lyrics and current-line highlighting, plus a pitch slider. *Criterion: sing a whole song in 2 different keys without drifting out of sync.*

**Phase 2 — API + cache + worker integrated.** Add-link endpoint, jobs, status, dedupe, lyrics source choice.

**Phase 3 — Rooms and queue.** Phone controller, WebSocket, preloading the next songs, skip/remove/reorder.

**Phase 4 — Robustness (done).** YouTube errors translated into clear messages, automatic retries only for transient failures, protection against a job that crashes the worker in a loop, duration and disk limits, cache cleanup by use (LRU), request rate limiting, detailed health checks and JSON logs. **Optional Postgres was left out**: with a single API instance SQLite is enough, and the switch only pays off together with multiple replicas (Phase 7).

**Phase 5 — Extras.** Scope decided with the project owner:

- **5a. Word-by-word lyrics with real timings.** Today the word highlight is estimated from the text length within the line. Alignment now stores each word's time in `lyrics.json` (`words`), and the player uses those times when present (with the current calculation as a fallback for lyrics without them).
- **5b. AI forced alignment.** Already exists (Whisper/stable-ts over the isolated vocals); the refinement here is to offer the alignment also for lyrics coming from LRCLIB or subtitles, to gain per-word timings.
- **5c. Pitch scoring from the microphone.** Optional and **decided by the room's host** (on/off); without it, nobody uses the microphone.
- **5d. Export MP4** of the song (instrumental + lyrics) to run the karaoke offline with songs the person already has.
- **Out of scope:** background video.

## 11. Risks and points of attention

- **YouTube terms / copyright:** downloading and removing the vocals of protected content may violate YouTube's terms and copyright. Fine for personal/private use at home; review before any public or commercial use.
- **yt-dlp breaks often** (YouTube changes). Pin the version, update regularly and treat download failures as a recoverable error.
- **Lyrics quality:** LRCLIB's timing is from *another* recording; live/remix versions may drift. Mitigate: compare duration and allow a per-song **lyrics offset** (±seconds), stored in the cache.
- **Demucs on CPU is slow** (several minutes per song). Without a GPU, preloading is what keeps the queue flowing; limit worker concurrency to 1 separation job at a time.
- **Pitch shift:** beyond ±6 semitones the audio degrades; and AudioWorklet needs a secure context (HTTPS or localhost) — a TV accessing through a local network IP needs HTTPS or extra care.
- **Browser autoplay:** the TV player needs an initial click to unlock audio.
- **WebSocket latency vs. lyrics:** lyric sync must use the player's local `audioContext.currentTime`, never network events.

## 12. Corrections to the original draft

- The draft's `extrair_youtube_id` function had the hostname `'://youtube.com'` (typo) and did not handle `www.youtube.com`, `m.youtube.com`, `/shorts/`, `/embed/`; use a regex or `yt-dlp --get-id` and validate the 11 characters.
- "The folder exists = ready" is fragile; use the criterion in section 5.
- Pitch shift over YouTube's original video would shift the vocal too; here it is applied to the instrumental.
- Changing the key "with FFmpeg in 2 s" on the backend is possible but would need one file per key; real-time pitch in the player avoids that.

## 13. Distributed deployment (API on AWS, worker with GPU)

Proposed hosting: API on an EC2 t3.micro, front-end on Vercel/Netlify, worker on a GPU machine. This works, but requires solving these points:

1. **Files must leave the worker.** If Demucs runs on another machine, the `instrumental` is not on the API's disk. The worker must upload the artifacts to an **object storage** (S3 or Cloudflare R2) and the API only keeps the index; the player plays through a URL (presigned or public). The t3.micro's 8 GB disk is no good as a cache.
2. **BullMQ has no mature Python consumer.** Use our own contract: the API does `XADD jobs` (Redis Streams, with a consumer group) with `{video_id, url, lyrics_source}`; the worker does `XREADGROUP`, updates `job:<video_id>` (status/progress) and publishes to a pub/sub channel that the API relays through Socket.io. A simpler alternative: the worker calls the API's HTTP endpoints (`POST /internal/jobs/claim`, `/progress`, `/complete`) authenticated by a token, and Redis stays inside the API.
3. **The worker does not accept inbound connections** (Colab/Kaggle and most GPU environments): it must always *pull* work (long-poll/stream), never be called by the API. Exposing Redis publicly requires a password + TLS; the HTTP-with-token model avoids that.
4. **Colab/Kaggle are not reliable as a permanent worker:** sessions drop (hour limits, idleness), the GPU is not guaranteed and there are restrictions on background jobs. They serve for the Phase 0 spike and tests. For real use: your own GPU machine (your home PC pulling from the API already solves it), an on-demand GPU instance, or Demucs on CPU with concurrency 1.
5. **yt-dlp on a datacenter IP is usually blocked by YouTube** (AWS, Colab). Options: download on the API/machine with a residential IP, use cookies from an account, or run the worker at home. Decide before Phase 2.
6. **t3.micro (1 GB RAM, 12-month free tier):** Fastify + Redis + SQLite fit, but no heavy local Postgres; keep SQLite (file with backup) or use a managed database.
7. **Secrets and CORS:** `.env` outside git; CORS restricted to the front-end's domain; rotatable worker token; size/rate limits on the queue endpoints.

## 14. Abstract storage: local now, S3/R2 later

**Initial mode: everything on the user's machine** (API, worker, Redis and files on the same computer; phones and TV access over the local network). With this, v1 has no EC2, no object storage and no exposed Redis, and yt-dlp's IP is residential. Section 13 only applies once there is a move to the cloud.

### Golden rule
No code outside the storage layer knows disk paths or bucket URLs. The rest of the system speaks in **logical keys**: `cache/<video_id>/instrumental.mp3`, `cache/<video_id>/lyrics.json`, `cache/<video_id>/meta.json`. The database stores only the key, never the absolute path.

### Interface (the same on both sides, Node and Python)
```
exists(key)            -> bool
put(key, local_path)   -> void        # the worker publishes the artifact (atomic: .tmp + rename / multipart)
get_url(key, ttl)      -> string      # URL the player can open
read(key)              -> bytes       # for the small lyrics.json / meta.json
delete(prefix)         -> void        # used by LRU cleanup
list(prefix)           -> [key]
```

### Drivers
| Driver | `get_url` returns | Notes |
|---|---|---|
| `local` (v1) | `http://<host>:<port>/media/<key>` served by Fastify with Range support | `put` = move the file to `STORAGE_ROOT/<key>`; block path traversal (`..`) |
| `s3` / `r2` (future) | presigned URL with TTL (or the CDN's public URL) | R2 uses the S3 API; same driver with a configurable `endpoint` |

Selected by configuration: `STORAGE_DRIVER=local|s3`, `STORAGE_ROOT`, `S3_ENDPOINT`, `S3_BUCKET`, etc.

### Consequences for the rest of the plan
- **The worker never hands a file path back to the job**, it only calls `put()` and reports `ready`. The API builds the URL through `get_url()` when it delivers the song to the player.
- **The "ready" criterion (section 5)** now uses `exists(key)` on both artifacts, not `os.path.exists`.
- **Worker and API share the `local` driver only if they see the same folder** (same machine or Docker Compose volume). If the worker ever moves to another machine, just switch to `s3` on both sides, without changing the pipeline, routes or player.
- **LRU cleanup** uses the driver's `list`/`delete`; the `last_played_at` column stays in the database.
- **The player** only receives URLs; it does not know whether they come from disk or a bucket. With S3/R2, the bucket needs CORS allowing the front-end's domain (required for the Web Audio API to read the audio).
- **Local network:** the player on the TV reaches the API through the machine's IP; remember HTTPS/secure context for AudioWorklet (section 11) or use `soundtouchjs` on ScriptProcessor/worklet through `localhost`/a tunnel.

### Contract test
Write a single test suite (`exists/put/get_url/read/delete/list`) run against the `local` driver and, in the future, against `s3` (with MinIO in Docker). If `s3` passes the same suite, the migration is just configuration.

### Migration plan (when the time comes)
1. Implement the `s3` driver + run the contract suite with MinIO.
2. A `migrate-storage` script: walks `list("cache/")` on local and does `put` into the bucket, verifying size/checksum.
3. Switch `STORAGE_DRIVER=s3` and restart; keep the local disk as a fallback for a week.
4. Only then move the API/worker off the machine (section 13).

## 15. Docker now, Kubernetes ready for later

Principle: **build with Docker Compose in v1, but already respecting the rules Kubernetes demands**. That way the migration is writing manifests, not rewriting code.

### 15.1 Images and Compose (v1)
One `Dockerfile` per app, `docker-compose.yml` at the root:

| Service | Image | Notes |
|---|---|---|
| `api` | `node:lts-slim`, multi-stage, non-root user | Fastify + Socket.io; port 3000 |
| `worker` | `python:3.11-slim` (CPU) and an `nvidia/cuda` variant (GPU) | ffmpeg, yt-dlp, demucs; no exposed port |
| `redis` | `redis:7-alpine` | volume for optional AOF |
| `web` | static build served by `nginx` (or by Fastify itself) | or hosted elsewhere |
| `db` (later) | `postgres:16` | v1 can stay on SQLite with a volume |

- **Volumes:** `storage` (local driver, shared between `api` and `worker`), `db`, `redis`.
- **GPU on Windows:** Docker Desktop with WSL2 + NVIDIA Container Toolkit; in Compose, `deploy.resources.reservations.devices` with `driver: nvidia`. Keep profiles (`--profile gpu` / `--profile cpu`) so the worker can run without a GPU.
- **Demucs model cache:** mount `TORCH_HOME` on a volume, so the weights are not downloaded every time the container is recreated.
- **Development:** `docker-compose.override.yml` with bind mounts and hot reload; production uses only the base file.
- **yt-dlp updates:** pin the version in the worker image and rebuild periodically (a simple routine, no updates at runtime).

### 15.2 Rules to keep the code "Kubernetes-ready"
1. **Configuration only through environment variables** (12-factor); no config file inside the image. Secrets (worker token, S3 credentials) also through env, never in the repository.
2. **No `localhost` or fixed IPs:** hosts come from env (`REDIS_URL`, `DATABASE_URL`, `PUBLIC_BASE_URL`, `STORAGE_DRIVER`).
3. **Stateless processes:** API and worker keep nothing important in memory or on the container's disk. State goes to Redis, the database and storage.
4. **API with several replicas:** use Socket.io's **Redis adapter** (`@socket.io/redis-adapter`) so events reach clients connected to another replica; `sticky sessions` on the ingress if using long-polling (or force WebSocket only).
5. **Database:** SQLite only works with 1 replica. Write the queries through an access layer (e.g. Kysely/Drizzle/Prisma) that allows switching to **Postgres** without refactoring. Move to Postgres before bringing up the second replica.
6. **Storage:** with more than one node, the `local` driver stops working (`ReadWriteMany` volumes are fragile). On K8s the default is `STORAGE_DRIVER=s3` (R2/MinIO); the section 14 contract already covers that.
7. **Health checks:** `GET /healthz` (liveness: process alive) and `GET /readyz` (readiness: Redis/DB reachable) on the API; on the worker, a heartbeat in a file/Redis that the probe checks.
8. **Clean shutdown (SIGTERM):** the API stops accepting connections and closes sockets; the worker finishes or **returns the job to the queue** (leaves no orphan job). Jobs need a *visibility timeout* / claim with expiry, so another worker can take over if one dies.
9. **Idempotency:** the pipeline is already resumable per step (section 4); that is what makes restarting pods safe.
10. **Logs to stdout/stderr as JSON** (pino on Node, `structlog`/JSON logging on Python), no log files; metrics at `/metrics` (Prometheus) when it makes sense.
11. **Known resource limits:** measure Demucs's RAM/CPU/VRAM in Phase 0 to fill in `requests/limits` later.
12. **Configurable worker concurrency** (`WORKER_CONCURRENCY`, default 1): on K8s, scaling = more worker replicas.

### 15.3 Added repository structure
```
singalong/
  apps/ api/ worker/ web/        # each with its own Dockerfile
  deploy/
    compose/                     # base + override + profiles
    k8s/                         # (future) base + overlays (kustomize)
      base/    api.yaml worker.yaml redis.yaml ingress.yaml configmap.yaml
      overlays/ local/ prod/
  docker-compose.yml
  .env.example
```
In v1, `deploy/k8s/` stays empty or holds only a README; do not keep unused manifests.

### 15.4 What it would look like on Kubernetes (reference)
- `api`: `Deployment` (2+ replicas) + `Service` + `Ingress` (WebSocket enabled, long timeouts).
- `worker`: `Deployment` with `nodeSelector`/tolerations and `resources.limits: nvidia.com/gpu: 1`. **Autoscaling by queue size** with KEDA (Redis Streams/list scaler), scaling to zero when the queue is empty.
- `redis`: a managed service or a simple `StatefulSet` (the queue is recoverable: lost jobs are recreated from `queue_items` in the database).
- `postgres`: a managed service.
- Config in a `ConfigMap`, secrets in a `Secret`; images tagged per commit.
- To test locally: `kind` or `minikube`; a local GPU on K8s is laborious, so use the worker on CPU in the test cluster.

### 15.5 Adjusted phases
- **Phase 0** (CLI spike) already runs inside a worker container, to pin dependencies and measure resources.
- **Phase 2** delivers `docker compose up` bringing up api + worker + redis working end to end.
- **Phase 4** includes health checks, clean shutdown, JSON logs and optional Postgres.
- **Phase 7 (optional): Kubernetes** — manifests with kustomize, Socket.io's Redis adapter, S3 driver enabled, KEDA for the worker.

## 16. Implementation status

| Phase | Status | Notes |
|---|---|---|
| 0 — Pipeline (CLI) | ✅ | yt-dlp + Demucs + lyrics (video/LRCLIB/text/LRC). A 3:42 track separated in ~8 s on an RTX 3060. |
| 1 — Standalone player | ✅ | Synced lyrics (per-word fill), ±6 pitch through AudioWorklet (SoundTouch), lyrics offset. |
| 2 — API + worker integrated | ✅ | Fastify + Redis Streams + consumer worker; `docker compose up` brings everything up. |
| 3 — Rooms and queue | ✅ | Rooms with code/QR, per-room queue (SQLite), WebSocket, TV + controller + host, preloading, fair rotation. |
| 4 — Robustness | ✅ | Translated errors, retries, limits, LRU cleanup, health checks, JSON logs. |
| 5a/5b — Word by word | ✅ | Real time of each word (`words` in `lyrics.json`), also for LRCLIB/subtitle lyrics; `refresh_words.py` fills in the old cache. |
| 5c — Microphone scoring | ✅ | The host turns it on in the room. See decisions below. |
| 5d — MP4 export | ✅ | "Baixar MP4" button (with key choice) on every library song. See decisions below. |
| 6 — React front-end | ✅ | Vite + React + TypeScript; landing, TV and room migrated, with 63 end-to-end tests. See decisions below. |

### Phase 2 decisions and lessons
- **No SQLite yet.** The library is the cache itself (`meta.json`); job state lives in Redis (`job:<id>`). SQLite comes in with rooms and queue (Phase 3).
- **The API serves the player and `/media`** (a single server, same origin). The `apps/web` test server was removed. We do not use `@fastify/static` (8.x versions had path-traversal flaws); our own file server has Range and traversal tests.
- **The API always builds the canonical YouTube URL** from the ID; the user never chooses yt-dlp's target.
- **Dedupe** of jobs in Redis by an atomic Lua script: `pending`/`processing` do not re-enqueue; `needs_lyrics` only re-enqueues with new lyrics (`PUT`); `failed` re-enqueues with a new `POST`.
- **`source.json`** keeps the video's metadata and subtitle in the cache: changing the lyrics does not download the video again.
- **Failure recovery:** on startup the worker first reads its own pending messages and claims (`XAUTOCLAIM`) those abandoned for more than `WORKER_STALE_SECONDS`. Tested with `SIGKILL` in the middle of separation: the job finished when the worker restarted.
- **redis-py trap:** the default `socket_timeout` (5 s) equals the `block` of `XREADGROUP`, which knocked the worker down every idle cycle; the worker now uses `socket_timeout=30`.
- **yt-dlp in the container** needs a JS runtime (Deno) and `yt-dlp[default]` to solve YouTube's challenges, plus cookies from a logged-in session.
- **Subtitles are optional, audio is essential.** The audio download and the subtitle download are separate yt-dlp calls: YouTube often answers `429` on the subtitle endpoint, and that cannot take the job down. Subtitles are only tried if the video has a **manual** subtitle in the requested languages; if it fails, the job ends in `needs_lyrics` with its own message.
- **Artist/title** also apply to `PUT /api/songs/:id/lyrics`: videos without "Artist - Song" in the title need them for the LRCLIB search.
- **YouTube video search** (outside the original plan; added in Phase 2): `GET /api/search?q=`. The API has no yt-dlp, so the request goes through Redis (`search:req` / `search:res:<id>`) to a **dedicated worker thread** (search cannot wait behind a long Demucs job). Results cached in the API for 10 min.
- **"Sing without lyrics"** (`source: none`) guarantees that any video gets into the library, even with no subtitles and no online lyrics.
- **Online lyrics duration:** LRCLIB is only usable if the duration matches (±5 s). With covers this often fails (e.g. a 265 s cover against 180–213 s versions). The `loose` option accepts the closest version, but the timings may not match; the underlying fix is forced alignment with AI (Phase 5).
- **YouTube subtitles and HTTP 429:** tested with PO Token (`bgutil-ytdlp-pot-provider`) and impersonation (`curl_cffi`): it did not help, and the failure also happens on other videos, so it is a YouTube limit on the IP/account, not on the video. We did not add those components. Subtitles remain an opportunistic source.
- **Automatic AI alignment** (brought forward from Phase 5, with approval): `lyrics.source = align`. The text is the user's; Whisper (`small`, through `stable-ts`) only marks *when* each line is sung, listening to `vocals.mp3` (the voice isolated by Demucs, which now stays in the cache). The language comes from the lyrics themselves (`langdetect`). Measured on "Unethical" against LRCLIB's timings: median error 0.29 s, 49/55 lines within 1 s, worst case 1.74 s (backing vocals). Cost: first time ~45 s (downloads the model, ~460 MB, to the `models` volume); afterwards ~7 s with the voice cached. Songs processed before this change have no `vocals.mp3`: the worker downloads and separates again the first time it aligns.
- **Outages of external services do not become a job failure:** LRCLIB answers 503 now and then; the worker tries 3 times and, if it persists, the job stops at `needs_lyrics` with "try again".
- **Searching lyrics through Google is not viable.** Tested: over plain HTTP Google returns the "enable JavaScript" page (without the lyrics panel, `data-attrid="kc:/music/recording_cluster:lyrics"`); with headless Chrome it lands on `/sorry` ("unusual traffic", captcha). Besides violating Google's terms, it is fragile. The panel is fed by Musixmatch; the same text exists on LRCLIB, which is an open API.
- **"Search the lyrics on the internet" now = LRCLIB + AI.** A version with timings and the same duration (±5 s) → uses the ready-made timings (`lrclib`); otherwise it uses the **text** of the candidate with the closest duration and the AI aligns it with the voice (`lrclib+align`). The "paste text with timings from another source" option left the interface (the `text` API remains and falls back to the AI when there is no reference). Old songs without `vocals.mp3` are downloaded and separated again only when the AI needs it (~30 s extra, once).
- Section markers such as `[Chorus]` are dropped before alignment (they are not sung).

### Phase 3 decisions and lessons
- **Roles:** the **TV** is the browser that plays (owner of the position and of the "ended" event); the **controllers** (phones) add and manage; the **host** (whoever created the room, with `host_token`) skips, pauses, reorders and removes anyone's songs. Everyone else only touches their own songs (identified by a browser `client_id`, which **never** goes in broadcast states: each connection receives `mine`/`can_edit` computed for it).
- **Commands over REST, state over WebSocket.** The WS only pushes state and receives `ended`/`position` from the TV (controller connections do not have that power). REST is idempotent and easy to test; the WS reconnects on its own with exponential backoff.
- **The server decides what plays.** `tryAdvance` picks the next **ready** item (with fair rotation, if on); an item still processing is **skipped and keeps its position**; a clock (`tick`, 1.5 s) advances the queue when processing finishes and broadcasts progress. A room's operations are serialized (lock per room).
- **Preloading:** the processing job starts **the moment the song enters the queue** (not when its turn comes), so the next one is usually ready when the current one ends.
- **Embedded SQLite (`node:sqlite`)**, no native dependency, in a **named volume** (`api-data`): Windows bind mounts do not go well with SQLite files. The `/data` directory must belong to the `node` user in the image.
- **Secure context:** AudioWorklet (key change) only exists on https or `localhost`. That is why the TV should open at `http://localhost:3000`; on http by IP it plays **without** key change and warns about it. Phones (controller only) work on http by IP. `crypto.randomUUID` also needs a secure context, so the browser id uses `crypto.getRandomValues`.
- **The TV's QR code** uses `PUBLIC_URL` (the computer's address on the network); without it, it uses the page origin and warns if it is localhost.
- **Bugs the tests caught:** the playing item came after those waiting (fair rotation gives a higher position); the DOM's `append` printed "null" for optional parts; the previous song's lyrics stayed on screen when switching songs.
- **Outside this phase:** multiple API replicas (the WebSocket hub is in memory; it would move to Redis pub/sub), worker priority by queue order (today it is arrival FIFO), local HTTPS for the TV by IP.

### Phase 5c: microphone scoring
- **Reference melody:** the worker extracts the pitch of the isolated voice (`librosa.pyin`, 1 MIDI note every 50 ms, -1 = no voice) into `cache/<id>/melody.json`. It is optional: without it (old cache without `vocals.mp3`) the song simply does not score. `refresh_words.py` generates the melody for the existing cache.
- **Who captures:** the **TV** opens the microphone (`getUserMedia`, with echo cancellation so the instrumental does not count as voice) and detects pitch with YIN in the browser itself; it requires `localhost` or https.
- **The score:** the song is checked in **2 s blocks, with ONE note per block**. The block's reference note is the one the original sustains most in it (notes occupying 40% or more of the block are the "main" ones); the singer's note is the one they sang most in the block. The two are compared ignoring the octave and with the key chosen for the song: credit falls off gradually with distance: 0 and 1 semitone are worth full credit, 2 are worth 80%, 3 are worth 50% and anything more is worth nothing. If the original sustains no note for 40% of the block, the most frequent one counts. Because the pitch detector fails on many frames of a real voice (the TV reads the microphone every 100 ms and holds the last note for 150 ms), there is a *participation* rule: detecting the singer in 40% of the block's readings already counts in full, and the detector's failure does not become the singer's mistake. It only counts with at least 5 s sung. The final score is the average of the blocks weighted by the time with voice in the original.
- **Smoothed melody:** the raw melody wobbles 4 to 6 times per second (vibrato, slides, detector errors). The player turns it into stable notes (median, merging runs within 1 semitone and absorbing runs shorter than 0.3 s) before choosing the block's note. The original voice's melody also discards instrumental bleed and whatever falls outside the lyric lines.
- **Debugging (commented out in `tv.js`; uncomment `onBlock` and the `console.table` to turn it on):** the TV logs to the browser console (F12) one line per closed 2 s block, `[score] 00:12–00:14 | original F#4 (main F#/A) | sung F#4 | distance 0 → hit 1 | readings 14/20 (participation 0.7)`, and a table (`console.table`) with all the blocks at the end of the song.
- **Calibration by simulation** (real melodies from the cache; an ideal singer who follows the raw melody, with detection failures): singing right ~84–90, random note ~50, fixed note ~43, 4 semitones off ~16, silence 0 (a real use showed ~70 before the credit falloff was relaxed). Raising the "main note" threshold drags everything down together; 40% was the point that best separates someone singing from someone guessing.
- **Server:** the room gains `scoring` (only the host changes it, `PATCH /rooms/:code`); the TV sends `{type:'score'}` at the natural end of the song (only for the playing item and with scoring on) and the score goes to `queue_items.score` and to the state's `scoreboard` (top 10). The phone shows the **Placar** (scoreboard); the TV shows the live score and the final result for 9 s.
- **Investigating the "far" blocks (4 and 5 semitones), done with a real use** (Fresno - Taxista, score 80; 91 blocks, 13 with 4 to 5 semitones of error: 6 exactly a fifth above the reference and 3 a major third above). The yardstick was the agreement between each version of the reference and the notes the person sang (the version in use reproduces the real note: hit ≤1 semitone 68%, average credit 80%). What was tested:
  - **Microphone/pitch detector (YIN):** simulated with synthetic voices with vibrato, noise and **without the fundamental and without the 2nd and 3rd harmonics**: it got 99–100% in every case, so the detector is not the cause (the suspicion was that it locked onto the 3rd harmonic, which falls a fifth above).
  - **Bass bleed in the isolated voice:** it exists (at 28–30 s the reference says B2, the 2nd harmonic of the instrumental's B1 bass, with 3× more low-frequency energy than the average), but filtering the voice's lows (100 and 150 Hz) or requiring energy in the mid frequencies barely moves anything: agreement 68% → 68%/67%, far blocks 13 → 13/10; the 150 Hz filter would even hide real notes from low voices. **Not applied.**
  - **A block with more than one note:** only 2 of the 12 far blocks have the sung note among the reference's.
  - **Microphone picking up the instrumental:** the sung note agrees more with the original voice (61%) than with the instrumental's bass (37%); only 4 of the 15 far blocks are near the bass. That is not what explains it.
  - **What remains** (~14% of the blocks) is consistent with **backing vocals and harmonies** (thirds and fifths) in the recording, which the isolated voice mixes with the lead, or with the person singing another note. It only improves with a separation that isolates the lead voice (e.g. another separation model), not with tweaks to the comparison.
- **Known limit:** it is pitch, not rhythm or lyrics; loud noise or the instrumental leaking into the microphone can earn undeserved points.

### Phase 5d: karaoke MP4 export
- **What comes out:** a 1280×720 video (plain background) with the instrumental and the lyrics: the title and artist at the start, the current line highlighted and **filled in word by word** (with the real times from `words`; without them, estimated from the length) and the next line in gray below. It plays on any device, offline and without Singalong.
- **How it is made:** the worker turns the lyrics into an **ASS** subtitle (the `\kf` karaoke effect) and ffmpeg burns it onto the background (`libx264`, `tune stillimage`, ~7 MB per 4-minute song; ~15 s to generate). The line appears 1.5 s before it is sung. Lines over 70 characters use a smaller font.
- **Key:** from -6 to +6, changed with ffmpeg's `rubberband` filter (the duration does not change, so the lyrics stay in time). One file per key: `cache/<id>/karaoke.mp4` (original key) and `karaoke_p+2.mp4`, `karaoke_p-3.mp4`...
- **Request:** `POST /api/songs/:id/export` `{pitch}` (404 if the song does not exist, 409 if it is not ready yet, 202 generating, 200 ready) and `GET /api/songs/:id/export?pitch=` to check. The request goes through Redis (`export:req`, state in `export:<id>:<pitch>`) to a **dedicated worker thread**, like search: it does not wait behind a long Demucs job. **The file existing** is the truth (the Redis state expires in 1 h); repeated requests do not duplicate.
- **Cleanup:** the MP4s sit in the song's folder and go away with it in the usage-based cache cleanup.
- **Limits:** plain background (background video remains out of scope); the MP4 uses the lyrics and key the song has in the cache at the time of the request; the room's lyrics offset (`lyric_offset`) does not go into the video.

### Phase 6: React front-end
- **Safety net first:** before touching any screen, 34 end-to-end tests (Playwright, real Chromium) described the behavior of the app that already existed: landing (4), room (17) and TV (13). They use only what the person sees (roles, labels and texts), so they ran unchanged before and after the migration. The test server (`apps/web/e2e/server.mjs`) uses the real API with an in-memory job queue, ready-made songs and Chromium's fake microphone.
- **Structure:** Vite with **three pages** (`index.html`, `room.html`, `tv.html`), so URLs, the QR code and host links stay the same; no router. Code in `apps/web/src`: `landing/`, `room/`, `tv/` (components), `lib/` (pure, tested logic, no React), `ui/` and `styles/style.css` (the same global CSS as before). `public/` holds only the files served as they are: SVG icons and SoundTouch's AudioWorklet processor, which the browser loads by URL.
- **What was reused without rewriting:** `lyrics-sync`, `queue-view`, `music`, `youtube`, `scoring`, `score-view`, `export-mp4` (pure logic, with their tests), the audio engine (`engine.js`), the preview (`preview.js`) and the CSS. They are JavaScript with `allowJs`; the new code (components, the TV controller, types for the API contract in `lib/types.ts`) is strict TypeScript.
- **TV:** the audio engine and scoring are imperative by nature (clock, microphone, AudioWorklet), so they live in a **controller** (`tv/controller.ts`) that draws nothing and notifies the screen through callbacks; the components draw from the state. The four lyric lines belong to the engine (it draws each word with its fill): React only hands over the elements.
- **Room:** the state comes from a hook (`useRoomConnection`: WebSocket with reconnection and the song position); actions go through a context (`act`, notices, name); the preview is the `usePreview` hook; the add panel is a component with its own state and a `chooseLyrics` function exposed to the queue. The host's settings (rotation, scoring) take effect immediately and only roll back if the server refuses.
- **Build and Docker:** `vite build` generates `apps/web/dist`; the API image has a stage that builds the front-end and copies the `dist` (the API serves that directory; `PUBLIC_DIR` overrides it). `npm run dev` opens Vite with a proxy to the API.
- **Free search and confirmation:** as on YouTube, the person searches by **artist, song title or both** (one is enough; `buildSearchQuery` joins them as "Artist - Title" or uses whichever exists), and the fields have no examples. After **choosing the video** (or pasting the link) the panel asks to **confirm the artist and the song title**, both required, because they feed the lyrics search and what shows in the queue. The confirmation comes pre-filled: what was typed in the search wins, and whatever is missing comes from a guess based on the video title (`guessArtistTitle`: splits on " - " and strips decorations like "(Official Music Video)" and "[OFFICIAL VIDEO]"). When changing the lyrics of an item already in the queue, the search disappears and only the confirmation shows.
- **Jukebox when adding:** when searching for a video, before going to YouTube the panel checks whether what was typed matches songs that are **already ready** (`findJukeboxMatches`: all typed words, whole, without accents or punctuation, in the artist, the title or the video title; one of the fields is enough, and with none it suggests nothing). If there are matches, it opens a `<dialog>` ("Encontramos esta versão pronta no nosso Jukebox, quer selecioná-la?" or, with several, "...estas versões... quer selecionar uma destas?") with the options and two buttons: use the chosen one (enters the queue right away, as in the Músicas tab) or "Buscar outra versão no YouTube" (continues the search and does not ask again for the same artist and title). Esc or a click outside closes it without doing anything.
- **Original video title:** `meta.json` also keeps `video_title` (the video's name on YouTube, e.g. "Faouzia - Unethical (MAPHRA Vocal Cover)"), besides the artist and song the person entered. The Jukebox search and the library filter look at all three, so someone asking for "Maphra + Unethical" finds a song stored as "Faouzia + Unethical", and the notice shows "No YouTube: ..." to tell the versions apart. Old songs get the title through a worker backfill (copies from `source.json` at startup, before the key backfill; both rewrite the same `meta.json`, so they run in sequence).
- **Player controls on the phone:** the "back/forward 10 s" gave way to a **draggable position bar** (host only; everyone else sees the progress bar): on release, the phone sends `POST /player/seek {to: seconds}` and the TV jumps to that point (the server also accepts the relative jump `{seconds}`; the two are mutually exclusive). The bar shows the destination immediately and follows the song from there. Pause/resume, skip, and the key buttons (− and +, also in the preview) use dedicated icons (`pause`, `resume`, `next-song`, `minus`, `plus` in `public/icons`), drawn as a mask like the rest; the name lives in `aria-label` and `title`.
- **Library on the phone:** the item has the song and "Adicionar" on the first line and, below, a "Vídeo MP4 para cantar offline" strip with the key and the download button in a single control.
- **Outside this phase:** Tailwind and per-component CSS (the global CSS stays; the `css.test.mjs` test prevents duplicate class names), a router and React StrictMode.

### Backing vocals level control
- **Idea:** next to the key, a 0 to 100% bar to let the recording's backing vocals through alongside the instrumental. Whoever picked the song controls it (and the host), like the key; the default is 0 (everything as before).
- **Separation (worker):** Demucs only delivers "voice" and "instrumental", and the voice mixes the lead with the backing vocals. A second pass uses a **UVR karaoke** model (`UVR_MDXNET_KARA_2`, MDX-Net, ~53 MB, downloaded the first time to the `/models` volume) over `vocals.mp3`: what it calls "Vocals" is the lead voice and the "Instrumental" is the backing vocals, saved to `cache/<id>/backing.mp3` (MP3 128 kbps). The `audio-separator` package (versions pinned in the Dockerfile) is installed with `--no-deps`, because one dependency (`diffq`, only for Demucs models) needs a compiler.
- **It does not hold the song up:** the song is ready without the backing; a **dedicated thread** (`backing.py`) analyzes it afterwards, one at a time (`backing:req` in Redis; at startup, also old songs without analysis). It takes ~1 to 1.5 min per song on CPU. The result goes in `meta.json` (`backing: {status: ready | none, share}`): if in fewer than 5% of the lead-voice stretches the backing reaches -15 dB of it (a single voice, like a cover), the song is marked `none`, gets no file, and the bar does not even show. Measured: "Taxista" (Fresno, with harmonies) 26% and "Unethical" cover (one voice) 0%; lead + backing reconstructs the original voice with an error of -40 dB.
- **Several tasks writing `meta.json`:** video title, key and backing complete the meta of already-ready songs. Each read the whole file, changed it and wrote it back (the slowest would overwrite the others), so they now use `update_meta` (`meta_store.py`): the read happens inside a lock, and the long calculation stays outside it. Redoing a song's lyrics also preserves the meta's `backing`.
- **API:** `queue_items.backing` (integer 0..100); `PATCH /rooms/:code/queue/:itemId` accepts `{pitch?, backing?}` (at least one; only the item's owner or the host); `song.media.backing` carries the URL only when the file exists.
- **TV (`engine.js`):** a second `<audio>` with the backing enters the **same SoundTouch input** (through a `GainNode`), so the backing changes key together. It only downloads the file when the level goes above 0, follows play/pause/seek of the instrumental and is **realigned every 0.5 s** if it slips more than 80 ms (two audio elements never run exactly together). Without the audio graph (http outside localhost) the element's own volume does the job.
- **The element's volume counts before the audio graph (defect found in real use):** with the level at 0 when the TV turned on, the graph did not exist yet and the engine zeroed the backing `<audio>`'s own `volume`; later, with the graph ready, only the `GainNode` was adjusted and the element stayed **muted forever**: the bar changed the state and never the sound. Fixed (with the graph, the element's volume stays at 1 and the gain is in charge). The tests only looked at the element's state, so they gained a test that **measures the output sound** (an analyser connected to the destination; the test backing is a 440 Hz tone against the instrumental's 220 Hz, so the sum is measurable: 100% = +3 dB, 50% = +1 dB, going back to 0% = base level), validated before the fix (it failed with ratio 1.003). With the real "Taxista": 100% = +4.6 dB, 50% = +1.6 dB, sync drift of 3 ms.
- **The backing is quiet relative to the instrumental:** on "Taxista" it sits at a median 28 dB below the instrumental (in the best stretches, 6 to 11 dB below): 100% is the balance of the original recording, so the effect is subtle for most of the song.
- **Torch trap in the worker image:** `onnx2torch` requires `torchvision`, and the newest `torchvision` pulls **torch 2.14 with CUDA 13** (+4 GB), which **breaks Demucs** (pinned to torch/torchaudio 2.5.1). A first version of the image did this silently and took the image from ~3 GB to 18.8 GB, which filled Windows' disk and hung Docker. Now `torchvision==0.20.1` goes in first, from the same index as torch, and the last line of the step **fails the build** if the torch version changes.
- **Limits:** the backing is never perfect (at high volume a "ghost" of the lead voice may leak); the **phone preview and the exported MP4** do not include the backing; scoring still compares with the whole voice's melody.

### Milestone M0: local agent API (Oct 2026)
First milestone of the installer plan ([TRD](TRD.md), section 12). Nothing changes for the classic setup (Docker worker reading Redis); rooms **without a session** behave exactly as before.
- **`Backend` in the worker:** `runner`, search, export and the backing-vocals thread no longer know Redis. `RedisBackend` keeps the old behavior; `HttpBackend` is the agent: it claims jobs, searches and exports from `/agent/v1` by long-poll, sends progress and the final state, and keeps a heartbeat so the room shows the owner as online during a long job. Terminal states are retried on connection failures (losing them would leave the job waiting 30 minutes); progress notices are not.
- **Sessions on the server:** `devices`, `pair_codes` and `sessions` tables, `rooms.session_id`, and per-session Redis streams (`jobs:s:<session>`, group `agents`, consumer = device id). The job's `starts` counter, the "job that crashes the worker in a loop" guard and the stale-claim logic carry over.
- **Routing:** `rooms.add` uses the room's session; search, lyrics change and export use the room code sent in `X-Room`. If the owner is offline the search fails right away with a clear message; jobs wait.
- **A real bug the end-to-end run found:** a `pending` job left in Redis by a crashed earlier run (its owner never came back) blocked every later request for the same song (the dedupe is right, the orphan was not). Fix: a request pending with an owner who has no signal is released when someone else asks for the song, and the old stream message is discarded if that owner returns. Lesson: the cross-language run (Node API + Redis + Python agent) caught what the unit tests could not.
- **Traps:** Fastify's Ajv drops extra body fields instead of rejecting them (so the server whitelists fields); `XREADGROUP` with id `0` returns the consumer's own pending messages first (that is the restart recovery, and why an agent only calls `claim` when idle); a stray `inspect.py` in a scratch folder shadowed the standard library when a script was run from there (run helper scripts with `python -I`).

### CI/CD and hosting (free cloud)
- **CI on GitHub Actions:** API (tests), front-end (TypeScript, unit, build and **end-to-end with Playwright**), worker (only `numpy` and `langdetect`, without torch) and the image builds (the worker's only on `main`, because it takes long). It passed on the first try on PR #1.
- **What can be hosted for free (research from Oct/2026):** only **API + Redis + the already-ready library**. The **worker does not fit**: YouTube blocks datacenter IPs ("Sign in to confirm you're not a bot") and cookies often do not fix it, besides vocal separation and lyrics alignment being heavy on CPU. New songs keep being processed on the home PC. Oracle Always Free [cut the free ARM to 2 CPUs and 12 GB in Jun/2026](https://infoq.com/news/2026/07/oracle-cloud-free-tier-limits/), requires a card to sign up and is sometimes out of capacity; free Render sleeps and loses the rooms; Fly.io has no free plan.
- **Design (`deploy/` folder):** an Ubuntu VM with Docker Compose: **Caddy** (automatic HTTPS with a free DuckDNS subdomain, required for key change and the microphone) → **API** → **Redis**; only 80 and 443 are exposed. The API image is built by CI for **amd64 and arm64** (the front-end is compiled once, on the CI machine, with `--platform=$BUILDPLATFORM`; only the server dependencies are assembled per architecture) and published to GHCR. Deploy is over SSH (`deploy.sh`), switched on by the `DEPLOY_ENABLED` variable; without it the workflow only publishes the image.
- **Copyright:** the repository is **public**, so the songs (`storage/`) never go to GitHub or into the image: `deploy/sync-library.sh` copies them over SSH, only what the cloud needs to play (without the isolated voice and `source.json`), to the private VM. Cache cleanup is off in the cloud (`CACHE_MAX_GB=0`), because there is no worker to redo whatever got deleted.
- **YouTube cookie:** today the worker sends it on **every** search and download. "Sign in with YouTube" does not solve it (Google's OAuth gives an API token, not the session cookie `yt-dlp` uses) and asking for other people's cookies is risky (it gives access to the whole account): discarded. Possible improvements: use the cookie only as a last resort (try without it first) and use a secondary account.
- **Measured on the free VM (Oct/2026):** with the latest yt-dlp, no cookie, from the Oracle IP, search works but downloads are mostly blocked (0 of 8 videos with the default client, 1 of 8 with `tv_embedded`), so switching yt-dlp clients does not fix an IP-based block.
- **Possible next step:** shared storage (S3/R2) so the home worker supplies the cloud on its own, without copying the library by hand (today the API's storage driver is local only), or a tunnel so the VM's yt-dlp goes out through the home IP.

### Phase 3b: key, previews, next singer and new layout
- **Key detection** (`worker/key.py`): chroma profile of the **instrumental** (librosa: HPSS + `chroma_cqt` with the file's tuning compensated) correlated with the 24 Krumhansl-Kessler profiles. Saved to `meta.json` (`key: {tonic, mode, score, margin, alt}`); old songs get the key in the background when the worker starts (~10 s each). Validation: synthetic audio **24/24** keys; on real songs, coherence when transposing was **19/24** with the current method (tied with STFT and better than CENS and CQT without HPSS). The errors cluster in ambiguous songs (major × relative minor), and the **margin between the 1st and 2nd key** predicts that: below **0.08** the screen says "Tom provável: X ou Y" (likely key: X or Y) instead of pretending certainty. It is an estimate, not a musical truth.
- **Next singer:** `next_item_id` in the room state, computed by the **same rule** that advances the queue (ready song + fair rotation). The TV shows "Cantando agora → Próximo"; the phone, "Próximo: …".
- **Previews:** (1) of the original **video**, with YouTube's embedded player (a domain without tracking cookies), per search result or pasted link; (2) of the **instrumental with key** on the phone, with the SoundTouch version based on `ScriptProcessor` (the AudioWorklet one only exists on https/localhost; the phone connects over http at the network IP). Cost: it decodes the whole song in memory. One preview at a time; it closes if the song starts playing on the TV.
- **Layout:** phone with a tab bar (Queue / Add / Songs), a fixed top bar with a ⋯ menu, a fixed preview above the tabs, 44 px touch targets and iPhone safe areas; TV with a "singing now / next" header, key and progress bar. The front-end is **plain HTML + CSS + JavaScript (ES modules), no framework and no build**, served by the API itself. *(Superseded by Phase 6.)*
- **Bug caught by visual review:** `.now`/`.next` classes collided between the TV, the phone card and the lyrics.
- **Open:** the TV opened by IP (http) still plays without key change; using the same `ScriptProcessor` SoundTouch on it would fix that, at the cost of decoding the whole song on the TV.

### Phase 3c: key as a note only, TV list and "yield your turn"
- **Key as a note only** ("Lá (A)", "Dó♯ / Ré♭ (C#/Db)"): the mode (major/minor) does not show, because it does not change when transposing and what the person needs is the note. Detection still stores the mode in `meta.json`. The doubt is only shown when the alternative has a **different note** (F major × D minor → "Fá (F) ou Ré (D)"); C major × C minor has the same note, so there is no doubt to show.
- **TV list:** the current song + the **next 5 in the order they will play** (the next one chosen by the server comes first, honoring fair rotation) + "+ N na fila". The waiting screen leaves the list in view.
- **Yield your turn:** `POST …/move {direction: "down"}` is now also allowed to the song's **owner** (postpones one position); `up` stays host-only. The phone shows "⇩ Ceder a vez" on the person's own songs and the "Próximo" tag on the item that plays next. Limitation: the swap is with the neighbor in queue order; with fair rotation on, the "next" may not be the neighbor below.

### Phase 3d: gap warning in the lyrics
- **The `--------------` warning** (14 dashes) on the TV, in place of the current line, in gaps of **≥ 8 s** (`MIN_GAP_SECONDS`): intro (counts from 0), solos and bridges. In the last **8 s** (`COUNTDOWN_SECONDS`) the dashes fade (14 → 1), so the singer knows **when** the line comes in; the next lyric already shows below. No warning after the last line. Pure, tested logic in `lyrics-sync.js` (`gapDisplay`).
- **Gaps hidden in the LRC:** the LRC only marks the start of each line, so a line's `end` is the start of the next and a solo "lives" inside the previous line (seen in "O Cantor e o Taxista": a 17.7 s "line"). `sungEnd` estimates the sung end (`0.12 s × letters + 2 s`, minimum 3 s) and only cuts lines longer than **1.5×** that estimate; the others keep the original `end`. This also applies to the line fill, which stopped "dragging" through the solo. It is a heuristic: a very long and genuinely sung stretch (> 1.5× the estimate and more than 8 s beyond it) may get the warning by mistake.
- On the library's 5 songs: a warning on the intro of all of them (11–16 s) and on the 2 solos of "O Cantor e o Taxista" (50–64 s and 98–116 s).

### Phase 3e: adding by Artist + Song title
- **Artist and Song title are required** in the form (before they were optional): **`Artist - Title`** searches the video on YouTube (`buildSearchQuery`) and the same two fields feed the lyrics search (LRCLIB) and what shows in the queue. The video link became a collapsed alternative ("Já tenho o link do vídeo"). The default lyrics became "Buscar a letra na internet".
- **The rule on the server too:** a song not yet processed without artist **and** title → `400 artist_title_required`. Songs already ready (library) are exempt, since they have the data in `meta.json`. Leading and trailing spaces are removed.
- **Google + Musixmatch as a lyrics source: discarded.** Google blocks automated access (captcha) and Musixmatch's official API on the free plan returns only **30% of the lyrics** (a preview); the full text needs a paid commercial license. LRCLIB remains the source of the **text**; the timings come from it (if the duration matches) or from the AI. If one day there is a paid Musixmatch key, the place to plug it in is `online_lyrics` in `pipeline.py`.
- **Bug caught by the end-to-end test with screenshots:** `.picked-box { display: flex }` (and `.check`, `.results`...) **overrode the `hidden` attribute**, leaving "hidden" boxes visible (including the fair-rotation button for non-hosts). Fix: `[hidden] { display: none !important }`. Lesson: the tests now check `getComputedStyle(...).display`, not just the `hidden` property.

### Phase 3f: library filter
- **Filter by artist and title** in the "already processed songs" tab (`filterSongs`, `queue-view.js`): case- and accent-insensitive (`normalizeText`, NFD), several words in **any order** and **all** must match; an "N of M" counter; a message and a "Limpar filtro" (clear filter) button when nothing matches. The filter survives list updates. Done in the browser (the library is small and already arrives whole from `GET /api/songs`); if it grows past a few hundred songs, it is worth moving to the server.
- The list now comes **in alphabetical order** by artist and then title (`sortSongs`), with the artist-less ones at the end. A `\u0000` as a separator in the sort key was ignored by the locale comparison and scrambled the order: the test caught it; it is now a proper comparator (`Intl.Collator`).
- Test trap: a check with `|| true` passed even when wrong; it was rewritten to fail if the filter did not ignore accents.

### Phase 3g: SVG icons instead of emojis
- **Own icons** (`public/icons/*.svg`, supplied by the project): `singing` (singer: top of the room, tabs, queue rows and TV header), `add-song` (Add tab), `musics` (Songs tab), `link` (Copy room link), `host` (Copy host link), `display` (Open TV and the "TV connected" status), `search` (Search on YouTube). No colored emoji left in the interface.
- **How they are drawn:** as a **CSS mask** (`mask-image` + `background-color: currentColor`), so they inherit the text color (gold on the active tab, gray on the others) instead of staying black. An `icons.js` helper (`icon(name)`) for JavaScript; `<span class="icon i-name">` in HTML.
- Text symbols that are not colored emoji stay (▲ ▼ ✕ ⋯ ⛶). The labels "Pausar", "Retomar", "Pular", "Prévia" and "Ceder a vez" lost the glyphs ⏸ ▶ ⏭ ⇩; the preview's play/pause button uses ▶/⏸ with U+FE0E, which forces the text version (without it some phones draw the emoji).
- **Giant "Próximo" tag:** a class-name collision: `.chip.next` inherited the huge font of `.next` (the next lyric line on the TV). It became `.chip.is-next`. In the same pass: the phone's `.singer` inherited the TV `.singer`'s `display:grid` (the icon was alone on a line) and became `.now-singer`.
- **Automatic guard:** `test/css.test.mjs` fails if a simple class is defined twice in the CSS (the cause of the three Phase 3 collisions: `.now`, `.next` and `.singer`); it was verified by deliberately reintroducing a collision. It also checks that each declared icon points to an existing SVG and that `[hidden]` beats the `display`s. The end-to-end test checks that no `\p{Emoji_Presentation}` is left on screen and that each icon loads the mask and has a visible size.

### Future roadmap: migrating the front-end to React
Decided with the project owner: **keep going with plain HTML/CSS/JS until Phase 4 is closed and migrate to React afterwards** (Phase 6). Reasons and cautions:
- **Why React:** `room.js` and `tv.js` redraw the screen by hand from the room state; with React the state becomes the source of the screen. The global CSS already caused three class-name collisions; components (CSS Modules or Tailwind) prevent that by construction.
- **What is reused without rewriting:** all the pure, tested logic (`lyrics-sync.js`, `queue-view.js`, `music.js`, `youtube.js`, `identity.js`), `engine.js` and `preview.js` (audio), the CSS (tokens and screens) and **the 100+ end-to-end tests**, which verify behavior on screen and serve as a safety net.
- **Migration plan (suggested):** Vite + React + TypeScript; `apps/web` gains `src/` and builds to `dist/`, which the API serves in place of `public/`; migrate one screen at a time (landing → controller → TV), keeping the end-to-end test green at every step; Tailwind optional.
- **Prerequisite:** the API does not change (REST + WebSocket are already the boundary).

## 17. Roadmap after 1.1.0 (decided Oct 2026)

Ideas chosen by the project owner after a review of what the app has and what is missing. Nothing below is built yet. **Decision:** processing in the browser (separating the voice with WebGPU/ONNX) is **not** part of the plan; separation stays on the server worker or the owner's agent. "Separating audio without downloading the song" was dropped with it, since the browser cannot read YouTube's stream.

### Phase A: foundation
| Item | Notes |
|---|---|
| Homologation and staging environments | Already designed in TRD 12.13. Done first so the following phases are released safely |
| Languages (i18n) and accessibility | Move every text into a catalog, then translate (English and Spanish first). Accessibility: contrast, keyboard focus, screen reader, large lyrics on the TV. The interface stops being a "non-goal" in Portuguese only |
| Web room with tabs, like the desktop app | The room page gets the **Room** and **TV** tabs (and the host panel), the TV becoming a mode of the same page. The `tv.html` route stays, so nothing breaks. **The QR code becomes the room link:** whoever enters through it lands in the room and chooses to stay on the **Room** tab or go to the **TV** tab to watch the lyrics and the songs playing. Care: a guest on the TV tab is a **viewer only** (no sound and no microphone, so two devices never play the same song); only the device that opened the TV as the player (or the host's choice) plays audio, and audio, microphone and full screen must stay stable there |

### Phase B: live audio (same engine, done together)
| Item | Notes |
|---|---|
| Latency compensation | Calibrate with a beat and the microphone, saved per device; affects scoring and lyrics, so it comes before the melody guide |
| Original-voice volume | A slider between the instrumental and the original voice (`vocals.mp3` is already stored); a guide for those learning the song. Host's mixer |
| Feedback (whistle) detector | FFT-based; lowers the voice volume by itself. Closes the "left" item of 12.14 |
| More than one microphone in the output | Several inputs in Web Audio with a limiter; the settings choose more than one device (also in the owner's app). Closes the other "left" item of 12.14 |

### Phase C: the party
| Item | Notes |
|---|---|
| Reactions from the phones | Applause, fire and emojis sent over the WebSocket and animated on the TV; a rate limit per person |
| Owner's statistics | Events recorded per room and song: most sung, processing time, cache size; helps clean the cache |

### Phase D: singing
| Item | Notes |
|---|---|
| Melody guide | Extract the melody from the isolated voice during processing (pYIN or CREPE) and draw it as bars on the TV, with the singer's pitch on top; reuses the scoring base. Depends on latency compensation |
| Duet with identified voices | Two layers. First **by lyrics**: each line marked voice 1, voice 2 or both (editor, plus a suggestion by speaker diarization on the isolated voice); the stage shows who sings what and scoring is per part. Later, **by audio**: real separation of the two voices (open research, a bonus) |

### Phase E: platform
| Item | Notes |
|---|---|
| Hybrid mode (F25) | Per song, choose whether it also goes to the cloud (S3/R2 driver already planned in section 14). Needs a decision on synchronization and storage cost |
| macOS, Linux and AMD/Apple GPU (F26) | The engine is assembled for Windows only. First macOS on Apple Silicon (MPS), then Linux (ROCm for AMD) |

### Phase F: the web home page
The entry page (`/`) gets the same look as the owner's app welcome screen: the **picture** (TV, laptop and phone, `apps/desktop/ui/welcome.png`) on the **left** and the actions on the **right**.
| Item | Notes |
|---|---|
| Layout | Two columns from ~900 px wide (picture ~64 %, panel ~36 %, like the app's `welcome-art`/`welcome-form`); on a phone the picture goes on top (smaller) and the panel below. The page keeps the dark theme, the language selector and the accessibility rules (axe in the suite) |
| Actions panel | **Create room and open the TV** (primary), **Join a room** (code field) and **Download the app** (secondary), plus a short sentence on why the app exists ("to prepare new songs on your computer") |
| Download button | The address comes from the server (`APP_DOWNLOAD_URL`, already used by the update notice), exposed in `/api/config` as `app_download_url` (and the latest version, `app_latest_version`, shown next to the button). With no address configured, the button is not shown. On a phone or a non-Windows computer the button explains that the app is for Windows computers (macOS and Linux are phase E) instead of downloading a useless file |
| The picture | Copied to `apps/web/public/` (the app keeps its own copy: its security policy only allows local files). It has the tagline "Karaokê de qualquer vídeo do YouTube" **drawn inside it**, and the screens inside it show the old menu: the picture should be re-exported **without the text** (the title and tagline become translated text) and with the current screens. Until then the page uses the current picture and cuts the text off with CSS if needed |
| Tests | The landing end-to-end tests are updated; new ones for the two-column and phone layouts, the download button (shown, hidden without an address, explanatory on a phone) and axe on the new page; the three languages get the new texts |

**Phase F status (release 1.1.3):** done. `/` now has the picture on the left and the actions on the right (stacked on a phone: picture on top); `GET /api/config` returns `app_download_url` (only `http(s)` links; it is `APP_DOWNLOAD_URL`, today the repository's `releases/latest`) and `app_latest_version`; the download block shows a **Download the app for Windows (vX.Y.Z)** link on a Windows computer, an explanation plus a "downloads page" link on a phone or another system, and nothing without an address. The current picture is used (copied to `apps/web/public/welcome.png`); re-exporting it without the baked-in Portuguese tagline and with the current screens is still open, and only its alt text is translated meanwhile.

**Decisions for phase F (answered)**
1. **Where is the installer hosted?** `APP_DOWNLOAD_URL` today points to a **private** folder (see `deploy/README.md`). A public button needs a link that anyone can open: GitHub Releases of this repository (the repository is public) or the link you already use. Without a public link the button stays hidden.
2. **The picture:** re-export without the text and with the current screens (recommended, needs the new art from you), or use the current picture for now.
3. **Order:** F is independent of A to E. Recommended: right after phase B (version 1.1.3), because it is small and visible; C, D and E follow.

*Answers:* (1) `APP_DOWNLOAD_URL` points to the repository's `releases/latest`; (2) the current picture for now; (3) F goes right after B, as 1.1.3.

**Versions:** phase A was released as **1.1.1**, B as **1.1.2**, F as **1.1.3**, C as **1.1.4** and D as **1.1.5**. **1.2.0** closes this roadmap with phases A, B, C, D and F. **Phase E (platform: hybrid mode, macOS, Linux and AMD/Apple GPU) and the homologation/staging environments (section 18) move to 1.3.0**; the PLAN keeps their design for then.

### Order and dependencies
A before everything (safe releases and the base for text and tabs) → B (one audio engine) → C (quick return) → D (needs B) → E (largest and most uncertain). Each item gets its own milestone, with tests, in the usual way (section 16).

### Phase A status (release 1.1.1)
- **Done:** the room page has the **Room | TV** switch (the TV tab is a viewer: no sound, no microphone; the QR code is the room link) and the interface is available in **Portuguese (Brazil), English and Spanish** (`apps/web/src/i18n/`: one catalog per language, a language selector on the entry page and in the room, the browser's language as the default; a test checks that the three catalogs have the same keys and that every key used in the code exists).
- **Server messages:** the API still answers in Portuguese; the client translates the error codes guests see (`apierr.*` keys) and falls back to the server's text for the others.
- **Accessibility (done):** automatic checks with axe-core on every screen and dialog (WCAG 2.1 A/AA, in the end-to-end suite); **lyrics size** buttons (A−/A+, also `+`/`−` on the TV) shared by the TV, the stage and the TV tab; a "skip to content" link; a screen-reader announcement of who is singing; `aria-current` on the tabs; `prefers-reduced-motion` and `prefers-contrast` support; a contrast fix on the TV queue.
- **Postponed:** the homologation/staging environments (section 18) are out of 1.1.1: they depend on the Oracle VM settings, which could not be checked (no access to the account). They return as soon as that is possible; milestones H1 to H3 do not need the VM.

## 18. Plan: homologation (`hml`) and staging (`stg`) environments

Design behind TRD 12.13. Nothing below is built yet; the open decisions are at the end and the plan assumes the recommended answer to each.

### Goal
A version is tried first on `hml`, then on `stg`, and only then promoted to production **by a person**, with the **same image** at every step (the tag is the commit; nothing is rebuilt).

### Path of a version (recommended)
| Event | Goes to | How |
|---|---|---|
| Push to `release/**` (CI green) | `hml` | automatic; the owner tries it with real phones and the TV **before** merging |
| Merge into `main` (CI green) | `stg` | automatic; a copy of production with the exact commit that will be released |
| "Promote" button (manual workflow, with an approval) | production | `workflow_dispatch` with the environment and the tag; GitHub **Environments** (`hml`, `stg`, `production`) with a required reviewer give the approval step |

Today every merge into `main` goes straight to production; that changes in the last step (production stops following `main`).

### Infrastructure (same free VM)
- **Three stacks, one VM:** one Docker Compose project per environment (`sg-hml`, `sg-stg`, `sg-prod`), each with its own API, Redis, volumes and `storage/` folder. The free Ampere VM (2 OCPU, 12 GB) fits the three; the 1 GB AMD fallback does **not**.
- **One entrance (Caddy) in a separate "edge" stack:** Caddy listens on 80/443 and routes three host names to `api` containers on a shared Docker network (`singalong-net`). Today Caddy lives inside the production stack, so a production deploy restarts it; moving it out also removes that coupling. The certificates volume (`caddy-data`) is **kept** (moved, not recreated) to avoid Let's Encrypt limits.
- **DNS:** `singalong-hml.duckdns.org` and `singalong-stg.duckdns.org` point to the same IP as production.
- **Directories:** `/opt/singalong` stays production (no move); `/opt/singalong-hml`, `/opt/singalong-stg` and `/opt/singalong-edge` are new.

### Isolation (what must never be shared)
- **Data:** each environment has its own volumes, database, Redis, `ADMIN_TOKEN` and `ADMIN_PATH`.
- **E-mail:** `hml`/`stg` have **no** `BREVO_API_KEY` (the server already answers `email_disabled`) and a test-only `PAIR_ALLOWED_EMAILS`, so nobody gets a test e-mail by mistake.
- **Cloud library:** `ENABLED_TO_SEND_TO_CLOUD` is empty in `hml`/`stg`; their `storage/` is separate from production's. `hml` gets a small library of the owner's own songs; `stg` may receive a read-only copy of production's library (decision 4).
- **Visible marker:** a new `APP_ENV` variable (`hml` | `stg` | empty = production) goes out in `/api/config`; the web pages show a colored ribbon and a `[HML]`/`[STG]` title prefix, so nobody mistakes one environment for another.

### Deploy and rollback
- `deploy.sh <env> <tag>` replaces the current `deploy.sh`: it uses the environment's folder, sets `IMAGE_TAG`, pulls that exact tag and waits for the API to be healthy.
- `deploy.yml` stops moving `latest` by itself: it publishes `ghcr.io/…/singalong-api:<sha>`, deploys to `hml`/`stg` according to the table above, and a second workflow, **Promote**, deploys a chosen tag to any environment (also used for **rollback**: promote the previous tag).
- Keep the last 5 tags on the VM (`docker image prune` keeps recent ones).

### The owner's app
The server address is already a setting of the app: for `hml`/`stg` the installer is pointed at their address by hand, and the update-notice variables (`APP_LATEST_VERSION`, `APP_MIN_VERSION`, …) are per environment, which allows testing the update flow with a fake newer version before publishing the Release.

### Milestones
1. **H1 – Compose parametrized** (project name, `IMAGE_TAG`, shared `singalong-net`), production unchanged. Test: production still deploys the same way.
2. **H2 – Edge stack** (Caddy outside production) with the production host only; a short, planned production downtime to move it.
3. **H3 – `APP_ENV` and the ribbon** (API, web, tests).
4. **H4 – `deploy.sh <env> <tag>`, `deploy.yml` and the Promote workflow**, with GitHub Environments.
5. **H5 – Create `hml`** on the VM (DNS, `.env`, small library) and deploy a `release/**` branch to it.
6. **H6 – Create `stg`** and make `main` feed it; production stops following `main`.
7. **H7 – Documentation** (`deploy/README.md`, TRD 12.13 becomes a "done" record).

### Open decisions (to confirm)
1. **Which VM do you have?** `VM.Standard.A1.Flex` with 12 GB (fits) or the 1 GB AMD fallback (does not fit three stacks; then `hml` and `stg` would have to share one smaller stack).
2. **The path of a version:** `release/**` → `hml`, `main` → `stg`, manual → production (recommended), or `main` → `hml` → manual → `stg` → manual → production (as in TRD 12.13, one more approval).
3. **Approvals:** use GitHub Environments with you as the required reviewer (recommended), or only a manual workflow without approval.
4. **Library in `stg`:** a read-only copy of production's songs (realistic, but copies copyrighted files to a second place on the same VM) or only a few of your own songs, as in `hml`.
5. **Edge stack:** accept a short planned production downtime to move Caddy out (recommended), or keep Caddy inside production and let `hml`/`stg` join its network.
6. **Names:** keep `singalong-hml.duckdns.org` and `singalong-stg.duckdns.org`.
7. **Transition:** keep production following `main` until H6 is done (recommended), so nothing changes before the new path is proven.

### Phase B status (release 1.1.2)
- **Latency compensation (done):** the TV has a **Delay** button (key `L`) with two sliders and an automatic measurement (it plays clicks through the speakers and listens to them on the microphone). *Sound delay* makes the lyrics (and the position sent to the phones) follow what is **heard**; *microphone delay* makes the scoring compare the note with the melody at the moment it was **sung** (`position - sound delay - microphone delay`). Stored per device (`localStorage`). The pure part is in `lib/latency.js` (tested with synthetic recordings); the measurement uses `ScriptProcessorNode`, so its precision is about one buffer (~10 ms).
- **Feedback detector (done):** an analyser listens to the microphone before the gain; `lib/feedback.js` looks for a narrow, nearly pure tone that stays on the same frequency and **grows** (or stays very strong for 0.8 s), with no strong harmonics (a sung note has them). Each detection halves the voice volume (down to 5 %), the TV shows a notice, and the volume comes back by 15 % per second after 3 s of silence, never above 80 % of the level where the whistle appeared (the limit is forgotten after a minute). Tested with synthetic spectra (tone, sung note with harmonics, siren, loud fixed tone, recovery).
- **More than one microphone (done):** a **Microphones** button on the TV (key `M`) lists the device's inputs; up to 4 can be ticked, one per singer, saved on that TV (`voiceMics`). Each microphone has its own analyser, feedback guard and gain (a whistle cuts **only that microphone**, and the notice says which); they are summed and go through a **limiter** (`DynamicsCompressor`, -6 dB, 20:1) so two singers never clip. The first ticked one also feeds the scoring (`openMic(deviceId)`); with none ticked the default microphone is used, as before. If one microphone does not open (unplugged), the others still work and the TV says so. In the owner's app the settings microphone is now only the default: a device the page chooses itself is no longer overridden (`room-preload.cjs`). Scoring is still **one** singer (the first microphone): scoring each singer is part of phase D.
- **Original-voice volume (done):** a new per-song level, `guide` (0 to 100 %), set like the backing vocals (whoever chose the song or the host; shown only on songs that have the file). The TV plays `vocals.mp3` in sync with the instrumental, inside the same key-change graph, so the guide is in the **key being sung**. The file is served by the server's storage (`media.vocals`) and by the owner's local media server (the catalog now carries `files.vocals`); **it is never uploaded to the cloud**, so songs that only exist in the cloud have no guide. The engine's extra tracks (backing and guide) share one implementation (`createStem`). The local media server's allow-list now includes `vocals.mp3` (its test was updated: the isolated voice used to be refused).
- **Phase B is complete.**

### Phase C status (release 1.1.4)
- **Reactions from the phones (done):** five buttons (clap, fire, love, party, wow) on the "now playing" card and on the TV tab. A tap sends `{type:'reaction', kind}` over the room WebSocket; the server accepts only the five kinds, from phones only, with a **token bucket per connection** (a burst of 6, then 3 per second; the rest is dropped silently) and broadcasts it, with the sender's name, to the TV, to the TV tab and to the singer's stage. The emojis rise and fade (3.2 s, at most 30 at once, `aria-hidden`; with reduced motion they only flash). Every reaction during a song is also counted on it (`queue_items.cheers`).
- **Owner's statistics (done):** the queue disappears with the room (24 h), so a new durable table, **`play_log`**, records one line when a song of an owner's room ends or is skipped (title, artist, singer name, a one-way key for the person, duet, score, cheers, outcome); no `client_id` is stored, and lines older than 400 days are pruned. `GET /agent/v1/stats?days=` (owner's token) returns the totals, top songs, top singers, most cheered and the per-day activity. The owner's app got a **Statistics** card on the Session tab (period selector) that also shows the **local library**: number of songs, disk space, average preparation time (sum of `timings_s` of each `meta.json`) and the biggest songs, which helps to clean the cache. The card's end-to-end check is in the app's window test, which only runs on CI (Windows).
- **Left to decide:** a host switch to mute reactions, and a "clean the biggest songs" action in the statistics card.

### Phase D status (release 1.1.5)
- **Melody guide (done):** a new host switch (room setting `melody_bars`, off by default). The TV draws a strip between the lyrics and the progress bar with the **notes of the original voice as bars** that scroll to the left (2 s of the past, 6 s of the future; the "now" line at a quarter of the width), in the **chosen key**, and the singer's pitch on top: **green** when it is on the note (octave ignored, up to 1 semitone off), **red** otherwise, drawn in the octave nearest to the bar. It reuses the melody the worker already extracts (`melody.json`) and the same smoothing as the scoring (`lib/melody-guide.js`, tested), and the latency settings (bars follow what is **heard**, the sung trail follows when it was **sung**). The microphone is shared with the scoring: the guide works without scoring (it then only needs a microphone on the TV).
- **Duet with identified voices, by lyrics (done):** the owner of the song and the guest (or the host) open **Split the lyrics** and mark each line as **voice 1**, **voice 2** or **together**; it starts from the automatic split. It is stored per song (`song_settings.parts`, a text with `a b * -`, one letter per line), applies in any room, and is sent only for songs with an accepted duet. The TV and the stage paint the lines with it; if the lyrics change size, the automatic split is used again.
- **Duet scoring per voice (done):** with scoring on, an accepted duet and **two or more microphones** chosen on the TV, the first microphone is voice 1 and the second is voice 2; each one has its own scorer that only counts the lines of that voice (lines marked "together" count for both). The final card shows each singer's score ("Ana 82 · Bia 74") and the room's score is the **average** (a song has a single score on the server). With one microphone nothing changes: the whole song is scored from it.
- **Left out on purpose:** the AI suggestion of who sings each line (speaker diarization of the isolated voice) and real separation of two overlapping voices; the editor starts from the automatic split instead. The editor reads the lyrics from the server; for songs on the owner's computer it only works while the song plays (the TV relays the lyrics).

**Release 1.2.0 (closing note):** phases A, B, C, D and F are done and released (1.1.1 to 1.1.5). Left for **1.3.0**: phase E and the homologation/staging environments (section 18, whose milestones H1 to H3 do not need the Oracle VM and can start the cycle).

### Fixes of 1.2.1
Found while using 1.2.0 on a real TV and microphone:
- **Lyrics fit the card:** a line that wraps into three lines no longer runs over the next one: the lines do not shrink any more, and the font is reduced step by step (`--fit`) until everything fits, on every line change. **The line that already passed is no longer shown.**
- **Score card on the far right**, outside the melody guide (the guide gets a margin the size of the card while scoring is on).
- **Colors in the melody guide:** in a duet the bars take the color of whoever sings that note (turquoise voice 1, violet voice 2, yellow together, dim outside the lyrics), like the lyrics; the current note gets a light outline, and the second singer's pitch trail is drawn too.
- **Voice noise and echo:** the voice path already used the browser's echo cancellation and noise suppression (AGC off, to avoid feedback). It now also has a **low-cut filter (110 Hz)** and a **noise gate** per microphone (opens above -46 dBFS, holds 280 ms, closes to 12 %): when nobody sings, the room noise and the leftover music no longer come out of the speakers. It is on by default and can be turned off in the **Microphones** dialog (kept on that TV). Part of an "echo" heard while singing is the unavoidable delay of listening to your own voice through the speakers (microphone + processing + output); only a lower voice volume, a wired setup or headphones for the singer remove it.
- **Top bar and side rail:** the language selector no longer stretches over the whole top bar (the global `select { width: 100% }` applied to it) and the side rail now sits below the top bar whatever its height (the top bar measures itself: `--topbar-h`).
- **Voice volume next to the switch:** the balloon only opens on hover (or keyboard focus), centered on the switch, and it now carries the switch's explanation (the tooltip used to cover the slider).

### Fixes of 1.2.2
- **The score card no longer floats:** it was `position: fixed` and covered the QR code in a smaller window (the owner's app). The TV now has a **lower strip** (`.tv-lower`) inside the layout: the melody guide and the score card side by side; without the guide the score is a low strip on the right. A test checks that no card overlaps another in four window sizes (900x600 to 1920x1080).
- **The lyrics gap warning starts at 3 s** (it was 8 s; `MIN_GAP_SECONDS`). The dashes are full at the start of the gap and fade over the last 8 s, or over the **whole gap when it is shorter than 8 s** (a 3 s gap has a 3 s countdown).
- **Owner's statistics layout:** the period selector was stretched to 260 px of height (a global `.card .row select { flex: 1 1 260px }` applied to it inside a column label). The card now has a header with the title and the controls on one line, the numbers in a grid, a chart with a caption and its date ends, and the lists in two columns.

### Fixes and additions of 1.2.3
- **The TV's right column fits its row:** with a full queue (the song playing plus seven waiting) the queue and the QR code card grew taller than the screen and fell on the lower strip (score card and melody guide) in smaller windows. The column is now a flex column bounded by its row: the queue shrinks (what does not fit fades out) and the QR code follows the screen height. A test fills the queue and checks that no card overlaps another, nor leaves the screen, in seven window sizes (960x560 to 1920x1080).
- **Version control and update message on the administrator page** (`app_release` table; `GET /state` returns `release` and the version of each computer; `PUT`/`DELETE /release`): what is published there replaces `APP_LATEST_VERSION`, `APP_MIN_VERSION`, `APP_NOTES` and `APP_DOWNLOAD_URL` of the `.env` **immediately**, for the installed apps (`/agent/v1/version` and the heartbeat) and for the home page (`/api/config`). It validates the format (`1.2.3`), that the minimum is not above the latest, the length of the message (500) and that the link is http/https. Each computer now reports its version in the heartbeat (`devices.app_version`) and the page shows who is up to date, who has an update available and who is below the minimum.
- **Signing the .exe, ready but waiting for a certificate:** `apps/desktop/scripts/signing.mjs` chooses the signature from the environment (certificate file via `CSC_LINK`, or Azure Trusted Signing; none = unsigned as before; `SINGALONG_REQUIRE_SIGNING=1` fails without a certificate) and `scripts/verify-signature.mjs` checks the result. The build verifies what it generated. It was proved end to end with a self-signed test certificate: the program, the installer, the uninstaller and `elevate.exe` came out signed and time-stamped. In CI the `installer` job uses the real certificate when the secrets exist and otherwise a throwaway test certificate. **What is missing is the certificate itself** (see the README for the options and their limits).

### Fixes and additions of 1.2.4
- **QR code beside the singer, the right column only for the queue:** on the TV the room QR code now sits at the left of "Singing now" (name, song and key), and the column beside the lyrics is left to the queue alone, which uses the whole height (the song playing plus the next five). The "Join room XXXX" caption stays under the QR code, so it is clear what it is for. Below 900 px wide the QR code is hidden, as the column was before. The no-overlap test now also checks that the QR code stays above the lyrics, to the left of the singer, and that the queue ends before the lower strip.

### Fixes and additions of 1.2.5
- **The app keeps its worker up to date:** the worker code inside the engine (`engine/app`, in the user data folder) was copied only when the engine was first built. After the app updated itself, the computer kept running the old worker: it reported an old version to the server (which can refuse it as "update required" and stop sending it work, such as the YouTube search) and lacked newer features (such as the cloud sync). Now, when the app opens with the engine already built, it compares the version of the worker shipped with the installer against the installed one and replaces the copy when they differ (`refreshWorker` in `apps/engine/src/assemble.js`; the log shows "Aplicativo do motor atualizado: 0.4.0 → 1.2.5"). Tests cover the copy (no leftovers from the old version, no change when up to date) and the controller.
