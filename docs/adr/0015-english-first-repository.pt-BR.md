---
status: aceito
date: 2026-10-19
---

# 0015. O repositório é escrito em inglês, com traduções em português

[English](0015-english-first-repository.md) · **Português (Brasil)**

O repositório é lido por pessoas que não falam português, incluindo avaliadores de fora do país, então tudo nele é escrito em inglês: código, comentários, nomes de testes, documentação, mensagens de commit e pull requests. Cada documento tem uma tradução em português ao lado (`*.pt-BR.md`) para quem fala a língua. O produto continua falando português: pt-BR é o idioma padrão da interface e a marca é em português.

## Consequências

- A partir de 2026-10-19, as mensagens de commit são em inglês, com no máximo duas frases e sem a linha `Co-Authored-By`; os commits antigos ficam como estão.
- Arquivos antigos ainda têm comentários em português; eles são traduzidos à medida que cada arquivo migra para TypeScript ([ADR 0011](0011-migrate-javascript-to-typescript.pt-BR.md), [ROADMAP](../ROADMAP.pt-BR.md)).
- Um documento e a tradução dele mudam juntos.
