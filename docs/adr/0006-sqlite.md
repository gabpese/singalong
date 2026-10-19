---
status: accepted
date: 2026-10-19
---

# 0006. SQLite holds the Rooms and the Queue

**English** · [Português (Brasil)](0006-sqlite.pt-BR.md)

One API instance serves everyone, on a free VM, so the state lives in SQLite: one file, nothing to operate, no extra service. Redis is used only as the job queue.

## Consequences

- **Move to Postgres when there is more than one API instance**; until then a second database server would only cost memory on a small VM ([ROADMAP](../ROADMAP.md)).
