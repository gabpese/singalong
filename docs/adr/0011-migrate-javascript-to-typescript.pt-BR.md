---
status: aceito (em andamento)
date: 2026-10-19
---

# 0011. Todo o JavaScript migra para TypeScript, aos poucos

[English](0011-migrate-javascript-to-typescript.md) · **Português (Brasil)**

> O [ADR 0017](0017-api-on-nestjs-with-mikroorm.pt-BR.md) troca a etapa de build da API: o `tsc` do TypeScript 7, não o `nest build`. Ele também condiciona a um teste prévio o plano de o motor e o app de computador rodarem sem build.

Quando o site passou para React, a lógica pura já testada (letra, fila, pontuação, o motor de áudio) ficou em JavaScript, e o código novo foi escrito em TypeScript estrito; por isso o repositório mistura `.js` e `.ts`. Uma revisão apontou a mistura, com razão. Todo arquivo JavaScript fora do worker migra para TypeScript, um app de cada vez: `apps/web/src/lib`, a API (direto para NestJS, [ADR 0016](0016-no-full-stack-framework.pt-BR.md)), o motor, o app instalável e depois os testes. O Node 24 roda arquivos `.ts` direto, então o motor e o app continuam sem etapa de build; a API ganha a etapa de build do NestJS, porque o Node não roda decorators. O `tsc --noEmit` no CI confere os tipos. Os comentários de cada arquivo são traduzidos para o inglês na mesma passada ([ADR 0015](0015-english-first-repository.pt-BR.md)).

## Alternativas consideradas

- **Migrar tudo de uma vez**: rejeitado; reescrever 151 arquivos de uma só vez travaria as novidades e arriscaria quebrar o que os testes não cobrem.
