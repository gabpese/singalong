---
status: accepted
date: 2026-10-20
supersedes: 0016 (for the API) and the build step in 0011
---

# 0017. The API moves to NestJS on Fastify, with MikroORM over SQLite

**English** · [Português (Brasil)](0017-api-on-nestjs-with-mikroorm.pt-BR.md)

The learning phase that [ADR 0016](0016-no-full-stack-framework.md) waited for is over. The API moves to NestJS on top of the same Fastify, for its modules and dependency injection. Its database access moves to MikroORM 7 over the built-in `node:sqlite` driver: entities, relations, versioned migrations, and a path to Postgres when there is more than one server ([ADR 0006](0006-sqlite.md)). The pages stay React with Vite and the desktop app stays Electron, as ADR 0016 decided.

The repository keeps one version of each language: TypeScript 7 and Node 24. TypeScript 7 checks and emits Nest's legacy decorators and their metadata, but it ships without the compiler API that `nest build`, ts-node and ts-morph import. So the API compiles with TypeScript 7's own `tsc` into `dist/`, without the Nest CLI. MikroORM entities are written with `defineEntity`, so neither its ts-morph metadata provider nor decorators are needed.

Today all 145 database calls are synchronous, so each Room rule runs to its end before any other message is handled. MikroORM is asynchronous only, so an `await` in the middle of a rule would let a second message act on half-updated state. Before any call becomes asynchronous, every command that changes a Room (HTTP route, WebSocket message, Intermission timer) runs through a first-in-first-out queue per Room code. Most already did, because finding the next ready song was already asynchronous; step 3.1 of the ROADMAP brought in the rest. Rules that span one statement (a pairing code, a Room code, a cheer) are settled by that single SQL statement. The agents' job claims live in Redis or in memory, outside SQLite, so the ORM does not reach them. Each request, WebSocket message, timer and long-poll round gets its own forked EntityManager, never one per connection, so no context outlives the data it cached.

The contracts stay as they are:

- The WebSocket stays a `@fastify/websocket` route at `/api/rooms/:code/ws`, with the same messages, registered from a Nest module.
- `/agent/v1`, which installed agents call, does not change.
- The JSON Schemas stay, written with TypeBox, so one schema both validates a request and gives its TypeScript type.
- `buildApp()` still returns the Fastify instance, so the `inject` tests and the e2e servers keep working; they import the API from `dist/`.
- The protocol types (`state`, `position`, the HTTP responses) are defined in the API, and the web imports them with `import type`.

Entities hold data and explicit relations, loaded with `populate` and never lazily. The Room rules stay in the services, so the existing tests keep describing the behaviour.

## Considered options

| Option | Why not |
|---|---|
| **Drizzle 1.0** | The closest alternative: it runs synchronously on `node:sqlite`, so the Room rules would not need a queue. Its `node:sqlite` driver only exists in the 1.0 release candidate, and it is a thin layer without a unit of work. MikroORM was chosen as the more complete ORM, accepting the asynchronous transition |
| **Prisma 7** | Only a `better-sqlite3` (native module) or libSQL adapter; its own schema language and code generation; asynchronous |
| **TypeORM** | Native SQLite drivers only; its migration CLI usually runs through ts-node, which needs the compiler API; asynchronous |
| **Kysely** | A query builder, not an ORM; `node:sqlite` only through third-party dialects |
| **Hand-written SQL** (as today) | Already safe, since every query takes parameters, but types, migrations and a move to Postgres stay manual |
| **`nest build` with TypeScript 6 installed beside 7** | Microsoft's recommended setup for tools that need the compiler API; two versions of one language |
| **A Nest WebSocket gateway** | `@nestjs/platform-ws` matches exact paths, so the Room code would leave the URL and the TV and phone protocol would change for no gain |
| **Rewriting the API in one pass** (ADR 0016's plan) | Replaced by one pull request per area, each green on CI |

## Consequences

- **Order.** First, still in JavaScript: concurrency tests for every rule that reads then writes, and the per-Room queue. Then Nest boots on the existing Fastify instance with MikroORM and a baseline migration. Then one pull request per area, from the least to the most concurrent: `release`, `cache-cleaner` and `admin`; `songs`; `agents`; `rooms`. Each moves its files to TypeScript, into a Nest module, onto MikroORM, and translates their comments. The [ROADMAP](../ROADMAP.md) lists the steps.
- **Baseline.** The current start-up code (`CREATE TABLE IF NOT EXISTS` and the `hasColumn` checks) runs one last time, then an initial migration is recorded as already applied. Every later schema change is a migration file.
- **Going back.** While the API migrates, migrations only add tables and columns, so the previous image still runs on a migrated database. `deploy.sh` copies the SQLite file before each deploy, and the API is deployed after each merged pull request.
- **`erasableSyntaxOnly`** applies where Node runs `.ts` directly (the web's `lib` and i18n, the engine, the desktop app, the tests). The API is compiled, so it may use Nest's parameter properties.
- **Engine and desktop app.** [ADR 0011](0011-migrate-javascript-to-typescript.md) expects them to run `.ts` without a build. Node refuses to strip types under `node_modules`, where the packaged app keeps the engine, and the main process runs on Electron's own Node. Before the engine migrates, a spike packages a `.ts` file with electron-builder. If it fails, both compile with the same `tsc` as the API.
- **CI and image.** The API job builds before it tests, the web and desktop jobs build the API before their e2e, and the Dockerfile gains a build stage.
