---
status: accepted
date: 2026-10-19
---

# 0001. Zero cost while the project earns nothing

**English** · [Português (Brasil)](0001-zero-cost-while-non-profit.pt-BR.md)

Singalong is a non-profit project, so every piece of it runs for free: an Oracle Cloud Always Free VM, Caddy and DuckDNS for the address and HTTPS, GitHub Actions for CI and the GitHub Container Registry for images, and the users' own computers for the heavy work of preparing songs. Choosing what is free is deliberate, not an oversight; the other ADRs follow from it.

## Consequences

- The cloud server is small (2 CPUs, 12 GB on the free tier) and cannot prepare songs ([ADR 0012](0012-installable-app-prepares-songs-locally.md)).
- The installers are not code-signed, so Windows and macOS warn on first run.
- Deploying to the VM is a manual `./deploy.sh` while `DEPLOY_ENABLED` is off.
- **Revisit when the project starts earning money**: a paid server, an own domain, signing certificates and automatic deploy ([ROADMAP](../ROADMAP.md)).
