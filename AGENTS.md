# AGENTS.md

**English** · [Português (Brasil)](AGENTS.pt-BR.md)

Singalong is a self-hosted collaborative karaoke: phones queue songs in a Room, a TV plays the instrumental with word-by-word lyrics, and a worker turns YouTube videos into karaoke tracks. Read [docs/architecture.md](docs/architecture.md) for how the parts fit, and [docs/GLOSSARY.md](docs/GLOSSARY.md) for the product's words (Room, Host, Jukebox, Stage, Duet, Intermission).

## Map

| Path | What it is | Runtime |
|---|---|---|
| `apps/api` | Rooms, queue, WebSocket state, media files, the agent API | Node 24, Fastify (moving to NestJS and MikroORM, [ADR 0017](docs/adr/0017-api-on-nestjs-with-mikroorm.md)), SQLite, Redis |
| `apps/web` | Landing page, Room (phone), TV, Stage | React + Vite, TypeScript (`src/lib` is partly JavaScript, migrating) |
| `apps/worker` | Download, vocal separation, lyrics alignment, MP4 export | Python 3.11, PyTorch |
| `apps/desktop` | The owner's installable app (tray, embedded TV and host pages) | Electron |
| `apps/engine` | Assembles the worker's runtime on the user's computer | Node |
| `deploy/` | The cloud VM: Caddy, compose file, `deploy.sh` | Docker Compose |
| `docs/` | Architecture, infrastructure, ADRs, roadmap, PRD, TRD, PLAN, brand | |

## Language

- Write everything in the repository in English: identifiers, comments, test names, docs, commit messages, PR titles and bodies.
- Portuguese lives in two places only: the `*.pt-BR.md` translation next to each doc, and the UI catalogs in `apps/web/src/i18n/`. Keep a doc and its translation in sync in the same change.
- Older files still carry Portuguese comments. Translate a file's comments in the same pass that migrates it to TypeScript ([ROADMAP](docs/ROADMAP.md)).
- The product speaks Portuguese: pt-BR is the UI's default language, and every on-screen string goes through the i18n catalogs (`pt.js`, `en.js`, `es.js` share the same keys; a test checks).

## Before you change

- **The UI**: read [docs/BRAND.md](docs/BRAND.md) first. Colors and fonts come from the tokens in `apps/web/src/styles/theme-bridge.css` (the desktop app keeps a copy; a test compares them). The ready-songs library is called the **Jukebox**. Copy never mentions price.
- **An architectural decision**: read [docs/adr/](docs/adr/). Changing one means a new ADR that supersedes the old. The ordered architecture work is in the [ROADMAP](docs/ROADMAP.md).
- **A tool or dependency**: the repository keeps one version per language: TypeScript 7, Node 24, Python 3.11. TypeScript 7 ships no compiler API, so pick tools that run through `tsc` or Node itself; the Nest CLI, ts-node and ts-morph would need TypeScript 6 beside it ([ADR 0017](docs/adr/0017-api-on-nestjs-with-mikroorm.md)).
- **The app version**: it lives in `apps/desktop/package.json` (and its lock), `apps/desktop/src/controller.js` (`APP_VERSION`) and `apps/worker/singalong_worker/version.py`. Bump the three together; a test checks.
- **Anything that costs money** (a paid API, a paid service): ask the owner first. The project runs at zero cost ([ADR 0001](docs/adr/0001-zero-cost-while-non-profit.md)).

## Checks

The commands are the `scripts` in each `package.json`. What they do not tell you:

| App | Run | Gotcha |
|---|---|---|
| `apps/web` | `npm test`, `npm run build`, `npm run e2e` | The e2e server serves `dist/`: build before e2e. Its rooms start with the intermission off; tests that need it turn it on. |
| `apps/worker` | `python -I -m unittest discover -s tests -t .` | Needs only `numpy langdetect websockets yt-dlp` (no PyTorch). |
| `apps/api`, `apps/desktop`, `apps/engine` | `npm test` | |

CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs all of them on `main`. The API image is published only after CI passes.

## Commits and pull requests

- Commit message: English, one or two sentences. End it at the message itself, with no `Co-Authored-By` trailer.
- Work on a branch (`release/X.Y.Z`, `fix/…`, `docs/…`), open a PR to `main`, merge with a merge commit.
- When the owner asks to review the edits first, leave them uncommitted.

## Release

1. Bump the version (three places above) and add a "What is new in X.Y.Z" section to `docs/PLAN.md` and `docs/PLAN.pt-BR.md`.
2. PR to `main`; wait for CI to pass.
3. Create the GitHub release `vX.Y.Z` as a **draft**, targeting the merge commit.
4. Build the Windows installer locally (`npm run dist:win` in `apps/desktop`) and upload `singalong_karaoke.exe`, `singalong_karaoke.exe.blockmap` and `latest.yml`.
5. Run the "Instaladores de Linux e macOS" workflow (`release-installers.yml`) with the tag; it attaches the AppImage, `latest-linux.yml` and the DMG.
6. Publish the draft as Latest once all six files are attached.
7. The owner runs `./deploy.sh` on the VM (automatic deploy is off) and sets the new version in the admin page.
