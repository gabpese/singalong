---
status: accepted
date: 2026-10-19
---

# 0002. One repository, one app per runtime

**English** · [Português (Brasil)](0002-monorepo-one-app-per-runtime.pt-BR.md)

Singalong is one product with one version, so it lives in one repository with an app per runtime under `apps/` (`api`, `web`, `worker`, `desktop`, `engine`). The contracts between them are tested together: the web's end-to-end tests boot the real API in the same process, and a test checks that the installer, the desktop controller and the worker carry the same version. Each app keeps its own language and dependencies.

## Considered options

- **One repository per app**: rejected; versions drift apart and a change that crosses the API and the web would need coordinated pull requests in two places.
