# Roadmap

**English** · [Português (Brasil)](ROADMAP.pt-BR.md)

What is planned next, without dates. What already happened is in the [PLAN](PLAN.md).

## Architecture work, in order

[ADR 0011](adr/0011-migrate-javascript-to-typescript.md) moves every JavaScript file outside the worker to TypeScript, and [ADR 0017](adr/0017-api-on-nestjs-with-mikroorm.md) moves the API to NestJS with MikroORM. The repository keeps one version of each language: TypeScript 7, Node 24 and Python 3.11.

Each step is one pull request (step 3 is several), merged with a merge commit. Only step 2 makes a release. A step adds `tsc --noEmit` to the CI job of the app it migrates, and translates the comments and test names of every file it migrates ([ADR 0015](adr/0015-english-first-repository.md)).

### 1. The web's `lib` and i18n catalogs in TypeScript (done)

- Every file in `apps/web/src/lib` and `apps/web/src/i18n` becomes `.ts`. `src/vendor` (SoundTouch, qrcode) is third-party code and stays JavaScript, with a `.d.ts` where needed.
- Imports name the `.ts` file (`allowImportingTsExtensions`), and `erasableSyntaxOnly` keeps the code runnable by Node, which runs the unit tests without a build. The tests' imports point to `.ts` in the same pull request.
- `pt.ts` defines the catalog type and `en.ts` and `es.ts` declare `satisfies Catalog`, so the compiler checks the keys the i18n test checks today.
- Types live next to their module. The shapes the server sends stay in `lib/types.ts` until step 3.
- `engines` becomes `>=24` in every app.

### 2. The device token in the system vault, then release 1.4.2 (done)

**Security.** After pairing, the installable app keeps its device token as plain text in `config.json`, in the user's data folder (`apps/desktop/src/controller.js`), while the [TRD](TRD.md) planned the system vault. A backup, a synced copy of that folder or a disk read from another account exposes the token, and whoever holds it acts as that computer until the owner revokes it.

- Encrypt the token with Electron's `safeStorage` (DPAPI on Windows, Keychain on macOS, the Secret Service on Linux) and keep only the encrypted value in `config.json`.
- On the first run after the update, encrypt a plain token found in the file and rewrite it.
- When the token cannot be decrypted (a profile copied to another computer, a replaced keychain), the app treats itself as unpaired: it deletes the token and returns to pairing. The old device stays in the owner's list, to be revoked.
- On Linux without a Secret Service, `safeStorage` falls back to a fixed key: keep the token and show a lasting notice in the app that it is not protected there.
- A program running as the same user can still ask the system to decrypt the token, so revoking the device stays the answer to a compromised computer.

### 3. The API on NestJS and MikroORM

[ADR 0017](adr/0017-api-on-nestjs-with-mikroorm.md). The API goes to the VM after each merged pull request. Until step 3 ends, a migration keeps every table and column the previous image uses (it adds tables and columns, or tightens a constraint the data already meets), so the previous image keeps running on a migrated database.

1. **Still in JavaScript (done).**
   - Concurrency tests (`apps/api/test/concurrency.test.js`) for the rules that read and then write: songs added at once at the per-person limit, "the TV ended" and "the Host skipped" arriving together, a score sent as the song ends, moves at once, a pairing code used twice, two session starts, two Rooms with the same code.
   - The first-in-first-out queue per Room (`src/serial.js`) already covered the HTTP routes, "ended" and the Intermission timers; the TV's score and the publishes of people joining and leaving now go through it too. A skip names the song on the Host's screen, so it never skips the next singer's song; session changes queue per computer; a cheer, a Room code and a pairing code are each settled by one SQL statement. The agents' job claims live in Redis or in memory, not in SQLite, so the ORM does not reach them.
   - `deploy.sh` copies the SQLite file with `VACUUM INTO` before each deploy and keeps the last five copies.
2. **NestJS and MikroORM in place (done).**
   - Nest boots on the existing Fastify instance and serves `/healthz` and `/readyz`. The other routes stay Fastify plugins, in a context of their own that keeps their error handler.
   - MikroORM 7 shares `db.js`'s `node:sqlite` connection (`src/database/sqlite-dialect.ts`), with entities from `defineEntity` that a test compares with the frozen schema, and a baseline migration that changes nothing.
   - TypeScript 7's `tsc` builds `dist/`; the Dockerfile gains a build stage; CI builds the API before its tests and before the web and desktop e2e. `buildApp()` is now async and still returns the Fastify instance.
3. **One pull request per area,** from the least to the most concurrent: `release`, `cache-cleaner` and `admin`; `songs`; `agents`; `rooms`. Each moves its files to TypeScript and into a Nest module, writes its JSON Schemas with TypeBox, and makes its database calls asynchronous through MikroORM, with one forked EntityManager per request, WebSocket message, timer and long-poll round. `rooms` comes in two pull requests: the Rooms on Nest and MikroORM, then the protocol types (`state`, `position`, the HTTP responses) in the API, which the web imports with `import type`.
   - **`release`, `cache-cleaner` and `admin`: done.** Each call gets its own forked EntityManager. The published app version is read once at start and kept in memory, so the agents' routes still read it synchronously. The admin page's static files stay a Fastify route (its address must end in "/"); its API is a Nest module under the secret address, with a guard for the token and the limits, TypeBox through a pipe, and a filter that answers an `HttpError` as before.
   - **`songs`: done.** No database work: TypeScript, a Nest controller, TypeBox schemas and a reusable `@RateLimit()` guard. The `SongService` is still built by `app.ts`, because the Rooms use it too. The pipe validates TypeBox schemas with Fastify's own Ajv and options, so coercion and dropped properties match the Fastify routes exactly.
   - **Primary keys `NOT NULL`: done.** db.js's schema declared `TEXT PRIMARY KEY` without `NOT NULL`, which lets SQLite store a null, so the entities typed every key as nullable. The first migration that changes the schema rebuilds the ten tables the way SQLite documents, with the foreign keys switched off outside the transaction: with them on, dropping `rooms` or `devices` deletes the Queue, the Sessions and the history in cascade. It keeps the rows, the `UNIQUE` and `CHECK` constraints, the indexes and the `AUTOINCREMENT` counters. Migrations now run one by one, each in its own transaction.
   - **`agents`: done.** The `AgentService` runs on MikroORM, with a forked EntityManager per call, and every caller awaits it: the Rooms' state, the songs and the admin page. `app.ts` now creates MikroORM before Nest and runs the migrations before anything reads the database, because the Rooms need the service before Nest starts. LegacyModule hands MikroORM to the Nest modules, so `@mikro-orm/nestjs` is gone. Two Nest controllers serve `/agent/v1`. The pairing routes are open, and the computer's routes go through a guard for the device token. The cloud file upload stays a Fastify route, with its own octet-stream parser and 80 MB limit, and it checks the token before reading the file. `@RateLimit()` can count by IP alone, as the e-mail code request does.
   - **`rooms`: done.** The `RoomService` runs on MikroORM inside the same per-Room queue, with a fresh EntityManager for every read, because a `nativeUpdate` does not refresh the entities an EntityManager already holds. Inside a transaction nothing waits on another service: the transaction holds the one SQLite connection until it ends. The HTTP routes are a Nest controller. The WebSocket is a Nest gateway at `/api/rooms/ws?code=…`, with the same messages ([ADR 0018](adr/0018-room-websocket-on-a-nest-gateway.md)). `queue-logic`, `reactions` and `serial` became TypeScript, `HttpError` moved to a file of its own, and `/api/config` moved to the release module. `db.js` now only builds the database and fills it for the tests.
   - **The protocol types: done.** `apps/api/src/protocol.ts` defines the Room's state, the WebSocket messages both ways and the HTTP answers the pages read. The API is typed against it: the snapshot, `personalize`, the gateway's events and the controllers. The web's `lib/types.ts` re-exports it with `export type`, so nothing of the API reaches the bundle. The web's own copies (the landing page's config, the search result, the export state) are gone, and the TV's and the phones' WebSocket messages are checked against `ClientMessage`.
4. **The rest of the API, and `db.js` retires,** in two pull requests.
   - **The shared files in TypeScript: done.** `jobs`, `storage`, `files`, `config`, `mailer`, `version`, `youtube`, `installers`, `logging` and `rate-limit`, with their comments in English. The Redis and the in-memory job stores implement one `JobStore` interface, and the in-memory one adds what only the tests use. Fastify's `rateLimited()` went, since every limited route is a Nest route now.
   - **`db.js` retires: done.** Its frozen schema is now the first migration (`Migration20261019000000_initial_schema`), listed before the baseline. It creates what a new database lacks and adds the columns an old one lacks, so on a database db.js had already built it runs once and changes nothing. The connection opens in `src/database/connection.ts`, `/readyz` asks MikroORM, and the tests fill the database through MikroORM (`test/fixtures.js`). The API's source has no JavaScript left, so `allowJs` went.

### 4. The engine (done)

The spike packaged `.ts` files with electron-builder and ran them in Electron 44 (Node 24.21, types stripped). The app's own `.ts` ran, packaged too, but a `.ts` under `node_modules`, where the packaged app keeps the engine, was refused. So the engine's source is TypeScript that Node runs directly (its tests, `node src/cli.ts` and the real-engine CI job), and `tsc` builds `dist/` only for the desktop app, which imports it through the package's `exports` ([ADR 0019](adr/0019-engine-runs-typescript-and-compiles-for-the-app.md)). The desktop app builds it before it starts, tests or packages, and the installer carries only its `dist/` and `manifest.json`.

### 5. The desktop app (done)

The main process runs its `.ts` directly, packaged too, and `tsc` only checks its types. The preloads (`.cts`) and the window's scripts (`ui/*.ts`) compile with `tsc`, each beside its source, so the app loads the same paths as before ([ADR 0020](adr/0020-desktop-main-process-runs-typescript.md)). `ui/bridge.ts` types the contract between the window and the main process: the snapshot, the tabs and every action with its argument and answer. `npm run build` builds the engine and the window before the app starts, tests or packages.

### 6. The tests

The remaining `*.mjs` and `*.test.js` files become `.ts`.

## Code in English

**Required.** The repository is English-first ([ADR 0015](adr/0015-english-first-repository.md)), but many older files still carry Portuguese comments and test names.

- Translate a file's comments and test names in the same pass that migrates it to TypeScript (above), so each file is touched once.
- Sweep what will not migrate in small pull requests of their own: the Python worker, the TSX components, the CSS and the shell scripts.
- UI text stays in the i18n catalogs, with Portuguese as the product's default.

## Infrastructure when the project earns money

[ADR 0001](adr/0001-zero-cost-while-non-profit.md). When Singalong generates revenue, revisit the free choices: a paid server, an own domain in place of DuckDNS, code-signing certificates for the installers, and automatic deploy.

## Postgres when there is more than one server

[ADR 0006](adr/0006-sqlite.md). SQLite stays while one API instance serves everyone. MikroORM ([ADR 0017](adr/0017-api-on-nestjs-with-mikroorm.md)) also speaks Postgres, so the move changes the driver and the migrations rather than the queries.

## AI lyrics and voices: paused (cost)

Generating lyrics by listening to the isolated voice (Whisper), choosing the catalog lyrics by the audio and telling who sings each line in a Duet. Measured and parked on the `release/1.4.0` branch; paused because the best results relied on a paid API.
