# Security policy

**English** · [Português (Brasil)](SECURITY.pt-BR.md)

## Supported versions

Only the [latest release](https://github.com/gabpese/singalong/releases/latest) receives security fixes. The installed app tells you when a newer version exists; update before reporting.

## Reporting a vulnerability

Please report privately, never in a public issue:

1. **Preferred:** GitHub's private vulnerability reporting, under [Security → Report a vulnerability](https://github.com/gabpese/singalong/security/advisories/new).
2. **Alternative:** email gabrielpese.arq@gmail.com with "Singalong security" in the subject.

Include what you found, the version, how to reproduce it and the impact you expect. Singalong is maintained by one person in their free time: expect an acknowledgement within a week. You will be credited in the fix's release notes unless you prefer otherwise.

## Scope

In scope:

- The API server (`apps/api`): rooms, host tokens, the agent API (`/agent/v1`), the admin page, media file serving.
- The installable app (`apps/desktop`) and the runtime it assembles (`apps/engine`), including the local media server.
- The web pages (`apps/web`) and the worker (`apps/worker`).

Out of scope:

- Deployments run by other people (their configuration is theirs).
- Copyright questions about the songs people process; each user is responsible for what they download or import.
- Denial of service through sheer volume on the free cloud instance.

## How Singalong protects what matters

- **The YouTube session never leaves the user's computer.** The installable app keeps the YouTube login on the machine that downloads; the server receives only a display nickname, never cookies, email or password.
- **Agents only make outbound connections** and accept a closed set of job options (a video id and lyrics choices), never arbitrary commands.
- **Device tokens** are stored in the app's configuration file inside the user's own data folder (`config.json`), encrypted by the system vault (DPAPI, the Keychain or the Secret Service); where the system offers none, the app says the token is unprotected. The owner can revoke a device from the server at any time.
- **Secrets stay out of the repository:** `secrets/` is git-ignored, and the server reads tokens and keys from environment variables.
- **The installers are not code-signed yet**; Windows SmartScreen and macOS Gatekeeper will warn on first run.
