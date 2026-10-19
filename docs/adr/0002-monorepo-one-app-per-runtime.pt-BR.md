---
status: aceito
date: 2026-10-19
---

# 0002. Um repositório, um app por runtime

[English](0002-monorepo-one-app-per-runtime.md) · **Português (Brasil)**

O Singalong é um produto só, com uma versão só, então vive num repositório só, com um app por runtime em `apps/` (`api`, `web`, `worker`, `desktop`, `engine`). Os contratos entre eles são testados juntos: os testes de ponta a ponta do site sobem a API de verdade no mesmo processo, e um teste confere que o instalador, o controlador do app e o worker têm a mesma versão. Cada app mantém a própria linguagem e as próprias dependências.

## Alternativas consideradas

- **Um repositório por app**: rejeitado; as versões se separam, e uma mudança que atravessa a API e o site precisaria de pull requests coordenados em dois lugares.
