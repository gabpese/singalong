---
status: accepted (in progress)
date: 2026-10-19
---

# 0011. All JavaScript moves to TypeScript, gradually

**English** · [Português (Brasil)](0011-migrate-javascript-to-typescript.pt-BR.md)

> [ADR 0017](0017-api-on-nestjs-with-mikroorm.md) replaces the API's build step: TypeScript 7's `tsc`, not `nest build`. It also puts the engine and desktop app's build-free plan behind a spike.

When the web app moved to React, the tested pure logic (lyrics, queue, scoring, the audio engine) stayed in JavaScript and new code was written in strict TypeScript, so the repository mixes `.js` and `.ts`. A review rightly pointed at the mix. Every JavaScript file outside the worker moves to TypeScript, one app at a time: `apps/web/src/lib`, the API (straight to NestJS, [ADR 0016](0016-no-full-stack-framework.md)), the engine, the desktop app and then the tests. Node 24 runs `.ts` files directly, so the engine and the desktop app keep no build step; the API gains NestJS's build step, because Node cannot run decorators. `tsc --noEmit` in CI checks the types. Each file's comments are translated to English in the same pass ([ADR 0015](0015-english-first-repository.md)).

## Considered options

- **Migrating everything at once**: rejected; a big-bang rewrite of 151 files would freeze features and risk breaking what the tests do not cover.
