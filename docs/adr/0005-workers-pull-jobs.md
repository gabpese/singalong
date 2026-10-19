---
status: accepted
date: 2026-10-19
---

# 0005. Workers pull jobs; the server never calls them

**English** · [Português (Brasil)](0005-workers-pull-jobs.pt-BR.md)

Songs are prepared on machines at home, behind routers, with no open ports. That only works if the worker asks for work instead of the API calling it. The self-hosted worker pulls from a Redis stream with a consumer group, a contract neutral between Node and Python; the installable app's agent pulls over outbound HTTPS with a long poll (`/agent/v1/jobs/claim`).

## Consequences

- Works behind any NAT without configuring the router.
- A claimed job comes back to the queue if its worker disappears, so a job can run twice; every step of the pipeline is idempotent (it skips itself when its file already exists).
