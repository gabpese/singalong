---
status: aceito
date: 2026-10-19
---

# 0005. Os workers buscam o trabalho; o servidor nunca os chama

[English](0005-workers-pull-jobs.md) · **Português (Brasil)**

As músicas são preparadas em máquinas em casa, atrás de roteadores, sem portas abertas. Isso só funciona se o worker pedir o trabalho em vez de a API chamá-lo. O worker hospedado em casa busca num stream do Redis com consumer group, um contrato neutro entre Node e Python; o agente do app instalável busca por HTTPS de saída com long poll (`/agent/v1/jobs/claim`).

## Consequências

- Funciona atrás de qualquer NAT, sem configurar o roteador.
- Um trabalho pedido volta para a fila se o worker sumir, então um trabalho pode rodar duas vezes; cada etapa do preparo é idempotente (pula a si mesma quando o arquivo dela já existe).
