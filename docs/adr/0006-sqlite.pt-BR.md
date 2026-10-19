---
status: aceito
date: 2026-10-19
---

# 0006. O SQLite guarda as Salas e a Fila

[English](0006-sqlite.md) · **Português (Brasil)**

Uma instância da API atende todo mundo, numa VM gratuita, então o estado vive no SQLite: um arquivo, nada para administrar, nenhum serviço a mais. O Redis serve só como fila de trabalhos.

## Consequências

- **Migrar para Postgres quando houver mais de uma instância da API**; até lá, um segundo servidor de banco só gastaria memória numa VM pequena ([ROADMAP](../ROADMAP.pt-BR.md)).
