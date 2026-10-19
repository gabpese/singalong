---
status: accepted
date: 2026-10-19
---

# 0013. A free VM behind Caddy, at a DuckDNS address

**English** · [Português (Brasil)](0013-free-vm-with-caddy-and-duckdns.pt-BR.md)

The public server is an Oracle Cloud Always Free VM ([ADR 0001](0001-zero-cost-while-non-profit.md)). DuckDNS gives the free subdomain, which leaves the owner in control of the address. Caddy gets and renews the HTTPS certificate on its own; HTTPS is required, because browsers only grant the microphone and the pitch-shift AudioWorklet to secure pages.

## Considered options

- **Free platform tiers (Render and similar)**: rejected; they sleep when idle and lose the Rooms kept in memory and on disk.

## Consequences

- **Move to an own domain** if the DuckDNS address proves limiting, or when the project earns money.
