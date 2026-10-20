# Documentation

**English** · [Português (Brasil)](README.pt-BR.md)

Start with the [architecture](architecture.md), then follow the links you need.

| Document | What it answers |
|---|---|
| [Architecture](architecture.md) | What the parts are, how a song request and a Turn flow, where each word lives in the code |
| [Infrastructure](infrastructure.md) | Where it runs, how a change reaches people, what each setting does |
| [Glossary](GLOSSARY.md) | The product's words: Room, Host, Jukebox, Stage, Intermission... |
| [Roadmap](ROADMAP.md) | What comes next |
| [Brand](BRAND.md) | How Singalong looks and speaks, and why |
| [PRD](PRD.md) | Product requirements |
| [TRD](TRD.md) | Technical requirements and the design of the installable app and agent |
| [PLAN](PLAN.md) | The history: every phase, decision and release |

## Architecture decisions (ADRs)

Each ADR records one decision and why it was made. To change a decision, write a new ADR that supersedes the old one.

- [0001. Zero cost while the project earns nothing](adr/0001-zero-cost-while-non-profit.md)
- [0002. One repository, one app per runtime](adr/0002-monorepo-one-app-per-runtime.md)
- [0003. The API is Node.js with Fastify](adr/0003-node-fastify-api.md)
- [0004. The worker is Python](adr/0004-python-worker.md)
- [0005. Workers pull jobs; the server never calls them](adr/0005-workers-pull-jobs.md)
- [0006. SQLite holds the Rooms and the Queue](adr/0006-sqlite.md)
- [0007. Phones and the TV are web pages, not native apps](adr/0007-web-clients-not-native-apps.md)
- [0008. Lyrics and key are drawn in the browser, not baked into a video](adr/0008-render-lyrics-and-key-in-the-browser.md)
- [0009. The server owns the Room; the TV owns the sound](adr/0009-server-owns-room-state-tv-owns-sound.md)
- [0010. React, with one page per screen and no router](adr/0010-react-multi-page-without-router.md)
- [0011. All JavaScript moves to TypeScript, gradually](adr/0011-migrate-javascript-to-typescript.md)
- [0012. Songs are prepared on each user's own computer](adr/0012-installable-app-prepares-songs-locally.md)
- [0013. A free VM behind Caddy, at a DuckDNS address](adr/0013-free-vm-with-caddy-and-duckdns.md)
- [0014. Own CSS from design tokens, without Tailwind or a component kit](adr/0014-own-css-with-tokens.md)
- [0015. The repository is written in English, with Portuguese translations](adr/0015-english-first-repository.md)
- [0016. No full-stack framework: Fastify, React with Vite, and Electron](adr/0016-no-full-stack-framework.md) (the API part superseded by 0017)
- [0017. The API moves to NestJS on Fastify, with MikroORM over SQLite](adr/0017-api-on-nestjs-with-mikroorm.md) (the WebSocket contract superseded by 0018)
- [0018. The Room's WebSocket is a Nest gateway](adr/0018-room-websocket-on-a-nest-gateway.md)
