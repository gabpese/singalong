---
status: accepted
date: 2026-10-21
supersedes: the desktop app's part of the "Engine and desktop app" consequence in 0017
---

# 0020. The desktop app's main process runs its TypeScript, and only the preloads and the window compile

**English** · [Português (Brasil)](0020-desktop-main-process-runs-typescript.pt-BR.md)

The spike behind [ADR 0019](0019-engine-runs-typescript-and-compiles-for-the-app.md) showed that Electron 44 runs the app's own `.ts` files, packaged too. That holds for the main process only. Electron loads a sandboxed preload as a CommonJS script, without Node's type stripping, and the window's scripts run in Chromium, which runs JavaScript only.

So the desktop app splits in two:

| Code | Files | How it runs |
|---|---|---|
| The main process | `src/main.ts`, `controller.ts`, `installers.ts`, `library-stats.ts` | As it is: `package.json`'s `main` is `src/main.ts`, and the tests import the `.ts`. `tsc -p tsconfig.json` only checks the types (`noEmit`, `erasableSyntaxOnly`). |
| The preloads and the window | `src/preload.cts`, `src/room-preload.cts`, `ui/*.ts` | Compiled by `tsc -p tsconfig.renderer.json`, each `.cjs` or `.js` beside its source, so `main.ts` and `index.html` load the same paths as before. The output is gitignored. |

`ui/bridge.ts` is the contract between the window and the main process: the snapshot, the tabs, and every action with its argument and its answer. The main process's `handle()`, the preload and the window's `act()` are typed by it, so a change there shows on both sides. `npm run build` builds the engine, checks the main process and compiles the rest. It runs before `npm start`, the tests, the e2e and the installer.

## Considered options

| Option | Why not |
|---|---|
| **Compile the whole app to `dist/`, like the API** | A build for the main process, which runs its source as it is, and the tests would import a copy instead of the code they check |
| **Compile the preloads and the window into a folder of their own** (`out/`) | `main.ts` and `index.html` would load other paths than the sources'; beside the sources, the paths stay the same in development and in the package |
| **A bundler for the window** (esbuild, Vite) | A second tool for five files that `tsc` already compiles |

## Consequences

- The installer carries the main process's `.ts` and the compiled `.cjs` and `.js`. Its `files` leave out `src/*.cts` and `ui/*.ts`.
- After editing a preload or a window script, `npm run build` (or `npm start`, which runs it) brings the change to the window. The main process needs no build.
- A preload is CommonJS. Under `verbatimModuleSyntax` it imports Electron with `import electron = require('electron')`.
- The desktop job in CI type-checks both parts on the three systems, since `npm test` builds first.
