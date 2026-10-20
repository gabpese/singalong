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

[ADR 0017](adr/0017-api-on-nestjs-with-mikroorm.md). The API goes to the VM after each merged pull request. Until step 3 ends, migrations only add tables and columns, so the previous image keeps running on a migrated database.

1. **Still in JavaScript (done).**
   - Concurrency tests (`apps/api/test/concurrency.test.js`) for the rules that read and then write: songs added at once at the per-person limit, "the TV ended" and "the Host skipped" arriving together, a score sent as the song ends, moves at once, a pairing code used twice, two session starts, two Rooms with the same code.
   - The first-in-first-out queue per Room (`src/serial.js`) already covered the HTTP routes, "ended" and the Intermission timers; the TV's score and the publishes of people joining and leaving now go through it too. A skip names the song on the Host's screen, so it never skips the next singer's song; session changes queue per computer; a cheer, a Room code and a pairing code are each settled by one SQL statement. The agents' job claims live in Redis or in memory, not in SQLite, so the ORM does not reach them.
   - `deploy.sh` copies the SQLite file with `VACUUM INTO` before each deploy and keeps the last five copies.
2. **NestJS and MikroORM in place (done).**
   - Nest boots on the existing Fastify instance and serves `/healthz` and `/readyz`. The other routes stay Fastify plugins, in a context of their own that keeps their error handler.
   - MikroORM 7 shares `db.js`'s `node:sqlite` connection (`src/database/sqlite-dialect.ts`), with entities from `defineEntity` that a test compares with the frozen schema, and a baseline migration that changes nothing.
   - TypeScript 7's `tsc` builds `dist/`; the Dockerfile gains a build stage; CI builds the API before its tests and before the web and desktop e2e. `buildApp()` is now async and still returns the Fastify instance.
3. **One pull request per area,** from the least to the most concurrent: `release`, `cache-cleaner` and `admin`; `songs`; `agents`; `rooms`. Each moves its files to TypeScript and into a Nest module, writes its JSON Schemas with TypeBox, and makes its database calls asynchronous through MikroORM, with one forked EntityManager per request, WebSocket message, timer and long-poll round. The `rooms` pull request defines the protocol types (`state`, `position`, the HTTP responses) in the API, and the web imports them with `import type`.

### 4. The engine

First a spike: package a `.ts` file with electron-builder and run it in Electron 44. Node refuses to strip types under `node_modules`, where the packaged app keeps the engine, and the main process runs on Electron's Node, not the system's. If the spike runs, the engine and the desktop app run `.ts` directly; if not, both compile with the same `tsc` as the API.

### 5. The desktop app

As the engine, following the spike's answer.

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
