# Roadmap

**English** · [Português (Brasil)](ROADMAP.pt-BR.md)

What is planned next, without dates. What already happened is in the [PLAN](PLAN.md).

## Code in English

**Required.** The repository is English-first ([ADR 0015](adr/0015-english-first-repository.md)), but many older files still carry Portuguese comments and test names.

- Translate a file's comments and test names in the same pass that migrates it to TypeScript (below), so each file is touched once.
- Sweep separately what will not migrate: the Python worker, the TSX components, the CSS and the shell scripts.
- UI text stays in the i18n catalogs, with Portuguese as the product's default.

## TypeScript everywhere outside the worker

[ADR 0011](adr/0011-migrate-javascript-to-typescript.md). One language on the JavaScript side; the worker stays Python.

1. `apps/web/src/lib` (the web app already compiles TypeScript)
2. `apps/api`, straight to NestJS (below)
3. `apps/engine`
4. `apps/desktop`
5. The tests (`*.mjs`, `*.test.js`)

The engine and the desktop app need no build step, since Node 24 runs `.ts` directly. Each step adds `tsc --noEmit` to that app's CI job.

## The API on NestJS

[ADR 0016](adr/0016-no-full-stack-framework.md). Once the learning phase is over, the API moves to NestJS on top of the same Fastify, in one pass with its TypeScript migration and comment translation. NestJS brings a build step to the API (`nest build`), since Node cannot run decorators. The pages stay React with Vite and the desktop app stays Electron.

## The device token in the system vault

**Security.** After pairing, the installable app keeps its device token as plain text in `config.json`, in the user's data folder (`apps/desktop/src/controller.js`), while the [TRD](TRD.md) planned the system vault. A backup, a synced copy of that folder or a disk read from another account exposes the token, and whoever holds it acts as that computer until the owner revokes it.

- Encrypt the token with Electron's `safeStorage` (DPAPI on Windows, Keychain on macOS, the Secret Service on Linux) and keep only the encrypted value in `config.json`.
- On the first run after the update, encrypt a plain token found in the file and rewrite it.
- On Linux without a Secret Service, `safeStorage` falls back to a fixed key: tell the owner the token is not protected there.
- A program running as the same user can still ask the system to decrypt the token, so revoking the device stays the answer to a compromised computer.

## Infrastructure when the project earns money

[ADR 0001](adr/0001-zero-cost-while-non-profit.md). When Singalong generates revenue, revisit the free choices: a paid server, an own domain in place of DuckDNS, code-signing certificates for the installers, and automatic deploy.

## Postgres when there is more than one server

[ADR 0006](adr/0006-sqlite.md). SQLite stays while one API instance serves everyone.

## AI lyrics and voices: paused (cost)

Generating lyrics by listening to the isolated voice (Whisper), choosing the catalog lyrics by the audio and telling who sings each line in a Duet. Measured and parked on the `release/1.4.0` branch; paused because the best results relied on a paid API.
