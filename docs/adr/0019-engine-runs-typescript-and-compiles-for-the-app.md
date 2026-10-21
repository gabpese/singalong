---
status: accepted
date: 2026-10-20
supersedes: the engine's part of the "Engine and desktop app" consequence in 0017
---

# 0019. The engine runs its TypeScript directly, and compiles it only for the packaged app

**English** · [Português (Brasil)](0019-engine-runs-typescript-and-compiles-for-the-app.pt-BR.md)

[ADR 0011](0011-migrate-javascript-to-typescript.md) expected the engine and the desktop app to run `.ts` without a build, and [ADR 0017](0017-api-on-nestjs-with-mikroorm.md) put that behind a spike: if the spike fails, both compile with the same `tsc` as the API. The spike packaged `.ts` files with electron-builder and ran them in Electron 44, whose Node 24.21 strips types:

| A `.ts` file… | `electron .` | Packaged app |
|---|---|---|
| of the app itself (inside `app.asar`) | runs | runs |
| of a package in `node_modules`, as the engine reaches the app | runs (a symbolic link) | refused: `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` |

Only the packaged app's import of the engine fails. So the engine's source is TypeScript that Node runs as it is: its tests, its command line (`node src/cli.ts`) and the CI job that assembles a real engine need no build. `tsc` turns it into `dist/` only for the desktop app, which imports it through the package's `exports` (`@singalong/engine/assemble`, `/engine`, `/verify`). The desktop app's scripts build it before `npm start`, the tests, the e2e and the installer (`apps/desktop/scripts/build-engine.mjs`). The engine follows the web `lib`'s rules: `erasableSyntaxOnly` and imports that name the `.ts` file.

## Considered options

| Option | Why not |
|---|---|
| **Compile the engine like the API** (ADR 0017's fallback): tests and the command line use `dist/` | A build before every test and before the real-engine CI job, where Node already runs the source |
| **Keep the engine's `.ts` out of `node_modules`** (copy it into the app's own files when packaging) | It runs without a build, but the import paths would differ between development and the packaged app |

## Consequences

- The installer carries the engine's `dist/` and `manifest.json` only: the desktop app's `files` leave out its `src/` and `tsconfig.json`.
- A developer runs the desktop app as before; the first `npm start` or `npm test` also installs the engine's tools (TypeScript and Node's types) and builds it.
- The desktop app's own code is decided in step 5 of the [ROADMAP](../ROADMAP.md). The spike shows that its main process can run `.ts` directly. The preload scripts (sandboxed) and its screens (a browser) cannot.
