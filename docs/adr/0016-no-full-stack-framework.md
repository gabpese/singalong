---
status: accepted (learning phase)
date: 2026-10-19
---

# 0016. No full-stack framework: Fastify, React with Vite, and Electron

**English** · [Português (Brasil)](0016-no-full-stack-framework.pt-BR.md)

Singalong began as a way to study tools the owner did not know well, such as ffmpeg and Demucs. Without knowing their limits yet, the owner chose not to commit to a full-stack framework that could lock later phases in, and wanted to learn the pieces a framework hides: Fastify for the server, React with Vite for the pages and Electron for the desktop app.

The composition also fits the product. A Room is real time, with a WebSocket per phone and per TV that full-stack React frameworks do not keep in their routes. The pages are opened by QR code, so rendering them on the server buys nothing; only the Home page is ever found by search. One process serves the API, the WebSockets and the built pages on the free VM ([ADR 0001](0001-zero-cost-while-non-profit.md)). The same built pages are reused as they are by the desktop app and by the end-to-end tests, which boot the API in the same process.

## Considered options

| Option | What it would be | Strengths | Weaknesses for Singalong |
|---|---|---|---|
| **NestJS** (on Fastify) | Structure for the server: modules, dependency injection, conventions | Strong, well-known conventions; built-in WebSocket gateways; runs on top of Fastify | Ceremony for a small API (decorators and classes everywhere); a rewrite of the whole API |
| **Next.js** | Full-stack React: pages, server and routes in one place | Conventions by folder layout; the most requested React framework; vast documentation | Its routes do not keep WebSockets open, so a custom server is needed and much of the framework is lost; server rendering does not help QR-opened screens; the static export the desktop app would use turns the API routes off |
| **React Router 7** (formerly Remix) | Full-stack React built on web standards (forms, loaders) | Close to HTML; a gentle step from plain React | The same WebSocket problem; a Room is real time, not a form; server rendering unused |
| **AdonisJS** | The "Laravel of Node": MVC with ORM, validation and auth | Conventions the owner already knows from Laravel; everything integrated | WebSockets need a separate package; a much smaller community; brings an ORM and auth Singalong does not need |
| **Laravel or Ruby on Rails** | The owner's known stacks | Mature, with strong conventions; real time through Reverb or Action Cable | A third language (PHP or Ruby) next to JavaScript and Python, the opposite of reducing languages; the pages would still be JavaScript |
| **Tauri** (instead of Electron) | A desktop app on the system's web view, with a Rust core | Much smaller installer, less memory | Brings Rust; uses WebKit instead of Chromium on macOS and Linux, a risk for the TV's audio (AudioWorklet, microphone) that would need retesting everywhere ([ADR 0012](0012-installable-app-prepares-songs-locally.md)) |

## Consequences

- With no framework, the conventions are ours to write and keep: [`AGENTS.md`](../../AGENTS.md) and the [architecture](../architecture.md) hold them.
- **The API moves to NestJS on Fastify** once the learning phase is over ([ROADMAP](../ROADMAP.md)): NestJS's modules and conventions on top of the same Fastify, done in the same pass as the API's TypeScript migration ([ADR 0011](0011-migrate-javascript-to-typescript.md)). A new ADR will supersede this one for the API.
- The pages stay React with Vite and the desktop app stays Electron: the reasons against Next.js, React Router and Tauri come from the product, not from the learning phase.
