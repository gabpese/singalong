---
status: accepted
date: 2026-10-19
---

# 0007. Phones and the TV are web pages, not native apps

**English** · [Português (Brasil)](0007-web-clients-not-native-apps.pt-BR.md)

A guest at a party installs nothing: they scan the TV's QR code and they are in. Any browser can be the TV, the key change runs in the browser without reprocessing the song, and the Owner's installable app shows these same pages. A native app would ask every guest to install something before singing.

## Considered options

- **Flutter or native apps**, suggested in a review to reduce the number of languages: rejected; every guest would need an install, and the worker would still be Python ([ADR 0004](0004-python-worker.md)).
