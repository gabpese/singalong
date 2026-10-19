---
status: aceito
date: 2026-10-19
---

# 0003. A API é Node.js com Fastify

[English](0003-node-fastify-api.md) · **Português (Brasil)**

A API é principalmente tempo real: Salas, a Fila e um WebSocket por celular e por TV, com muitas conexões abertas ao mesmo tempo, que é onde o Node é mais forte. Ela também fala a mesma linguagem do site, e isso permite que os testes de ponta a ponta do site importem o código da API e a rodem no mesmo processo, sem Docker.

## Alternativas consideradas

- **Tudo em Python (FastAPI)**, uma linguagem a menos já que o worker é Python: rejeitado pelos motivos acima; a linguagem do worker é imposta pelas ferramentas dele ([ADR 0004](0004-python-worker.pt-BR.md)), a da API não.
