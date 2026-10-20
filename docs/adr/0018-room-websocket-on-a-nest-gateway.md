---
status: accepted
date: 2026-10-20
supersedes: the WebSocket contract in 0017
---

# 0018. The Room's WebSocket is a Nest gateway

**English** · [Português (Brasil)](0018-room-websocket-on-a-nest-gateway.pt-BR.md)

[ADR 0017](0017-api-on-nestjs-with-mikroorm.md) kept the Room's WebSocket as a `@fastify/websocket` route at `/api/rooms/:code/ws`, because a Nest gateway matches exact paths. Once every HTTP route of the API sat in a Nest controller, that route was the one channel left outside Nest's modules, dependency injection and per-message handlers. The owner chose to move it.

The Room's WebSocket is a gateway (`@nestjs/websockets` with `@nestjs/platform-ws`), on the same HTTP server as Fastify. The Room code moves to the query string: `/api/rooms/ws?code=ABCD&role=tv|controller&client=…&host=…&name=…`. The messages do not change. The adapter's message parser reads the protocol's own `{ type, ... }` as Nest's `{ event, data }`, and the server keeps sending `{ type, ... }`. Each message type has its handler (`hello`, `reaction`, `position`, `lyrics`, `score`, `ended`). The gateway checks whether a TV or a phone sent the message before the Room's service acts on it.

## Considered options

| Option | Why not |
|---|---|
| **Keep the `@fastify/websocket` route** (ADR 0017) | The same address and no new dependency, but the one channel outside Nest, with its message dispatch written by hand |
| **A custom adapter that matches `/api/rooms/:code/ws`** | It keeps the address, but it overrides the adapter's internal path matching, which a Nest update could change |

## Consequences

- **The address changed.** The pages come from the same server, so a page opened after the deploy uses the new address. A page left open during the deploy connects again only after a reload. The installed app and the agent do not use this WebSocket.
- **Dependencies.** `@fastify/websocket` left the API. `@nestjs/websockets` and `@nestjs/platform-ws` came in, at the same version as the rest of Nest.
- **Frame limit.** A frame over 1 MB is refused. The largest message, the TV's lyrics, stays under 400 KB.
- **Logging.** The upgrade request no longer passes through Fastify, so Fastify's request log no longer records it, nor the Host token in its address.
- **Tests.** A test can call the gateway's handlers with a stand-in socket, without opening a connection.
