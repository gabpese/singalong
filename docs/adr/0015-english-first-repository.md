---
status: accepted
date: 2026-10-19
---

# 0015. The repository is written in English, with Portuguese translations

**English** · [Português (Brasil)](0015-english-first-repository.pt-BR.md)

The repository is read by people who do not speak Portuguese, including reviewers abroad, so everything in it is written in English: code, comments, test names, documentation, commit messages and pull requests. Each document has a Portuguese translation next to it (`*.pt-BR.md`) for people who speak the language. The product itself still speaks Portuguese: pt-BR is the UI's default language and the brand is Portuguese.

## Consequences

- From 2026-10-19, commit messages are in English, at most two sentences, with no `Co-Authored-By` trailer; older commits stay as they are.
- Older files still carry Portuguese comments; they are translated as each file migrates to TypeScript ([ADR 0011](0011-migrate-javascript-to-typescript.md), [ROADMAP](../ROADMAP.md)).
- A document and its translation change together.
