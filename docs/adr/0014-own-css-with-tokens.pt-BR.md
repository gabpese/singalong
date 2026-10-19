---
status: aceito
date: 2026-10-19
---

# 0014. CSS próprio a partir de tokens, sem Tailwind nem kit de componentes

[English](0014-own-css-with-tokens.md) · **Português (Brasil)**

O visual vem da marca ([BRAND](../BRAND.pt-BR.md)): tokens de design num arquivo só (`apps/web/src/styles/theme-bridge.css`) alimentam uma folha de estilo global. Kits de componentes e frameworks utilitários foram rejeitados no redesenho da 1.4.0 porque trazem o visual genérico que o redesenho quis tirar. Um teste mantém os nomes de classe únicos na folha global, e outro mantém idêntica a cópia dos tokens no app instalável.
