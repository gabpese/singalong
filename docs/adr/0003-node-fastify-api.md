---
status: accepted
date: 2026-10-19
---

# 0003. The API is Node.js with Fastify

**English** · [Português (Brasil)](0003-node-fastify-api.pt-BR.md)

The API is mostly real time: Rooms, the Queue and a WebSocket per phone and TV, with many connections open at once, which is where Node is strongest. It also speaks the same language as the web app, and that lets the web's end-to-end tests import the API source and run it in the same process, without Docker.

## Considered options

- **Everything in Python (FastAPI)**, one language fewer since the worker is Python: rejected for the reasons above; the worker's language is forced by its tools ([ADR 0004](0004-python-worker.md)), the API's is not.
