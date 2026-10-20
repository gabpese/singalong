---
status: aceito para as páginas e o app de computador; substituído na parte da API pelo 0017
date: 2026-10-19
---

# 0016. Sem framework completo: Fastify, React com Vite e Electron

[English](0016-no-full-stack-framework.md) · **Português (Brasil)**

> A parte da API foi substituída pelo [ADR 0017](0017-api-on-nestjs-with-mikroorm.pt-BR.md): NestJS sobre o Fastify, com MikroORM.

O Singalong começou como um jeito de estudar ferramentas que o dono não conhecia bem, como o ffmpeg e o Demucs. Sem conhecer ainda os limites delas, o dono preferiu não se prender a um framework completo que pudesse travar as fases seguintes, e quis aprender as peças que um framework esconde: o Fastify no servidor, o React com Vite nas páginas e o Electron no app de computador.

A composição também combina com o produto. A Sala é tempo real, com um WebSocket por celular e por TV, que os frameworks completos de React não mantêm nas rotas. As páginas são abertas por QR code, então renderizá-las no servidor não traz ganho; só a Home é encontrada por busca. Um processo só serve a API, os WebSockets e as páginas prontas na VM gratuita ([ADR 0001](0001-zero-cost-while-non-profit.pt-BR.md)). As mesmas páginas prontas são reaproveitadas como estão pelo app de computador e pelos testes de ponta a ponta, que sobem a API no mesmo processo.

## Alternativas consideradas

| Alternativa | O que seria | Pontos fortes | Pontos fracos para o Singalong |
|---|---|---|---|
| **NestJS** (sobre o Fastify) | Estrutura para o servidor: módulos, injeção de dependência, convenções | Convenções fortes e conhecidas; WebSocket nativo; roda sobre o Fastify | Cerimônia para uma API pequena (decorators e classes em tudo); reescrever a API inteira |
| **Next.js** | React completo: páginas, servidor e rotas num lugar só | Convenções pela organização das pastas; o framework de React mais pedido; documentação enorme | As rotas não mantêm WebSocket aberto, então é preciso um servidor próprio e boa parte do framework se perde; renderizar no servidor não ajuda telas abertas por QR; a exportação estática que o app de computador usaria desliga as rotas de API |
| **React Router 7** (antigo Remix) | React completo sobre os padrões da web (formulários, loaders) | Próximo do HTML; um passo suave a partir do React puro | O mesmo problema do WebSocket; a Sala é tempo real, não formulário; renderização no servidor sem uso |
| **AdonisJS** | O "Laravel do Node": MVC com ORM, validação e autenticação | Convenções que o dono já conhece do Laravel; tudo integrado | WebSocket fica num pacote à parte; comunidade bem menor; traz ORM e autenticação de que o Singalong não precisa |
| **Laravel ou Ruby on Rails** | As stacks que o dono já conhece | Maduros, com convenções fortes; tempo real com Reverb ou Action Cable | Uma terceira linguagem (PHP ou Ruby) ao lado de JavaScript e Python, o contrário de reduzir linguagens; as páginas continuariam em JavaScript |
| **Tauri** (no lugar do Electron) | App de computador sobre o navegador do sistema, com o núcleo em Rust | Instalador muito menor, menos memória | Traz Rust; usa o WebKit no lugar do Chromium no macOS e no Linux, um risco para o áudio da TV (AudioWorklet, microfone) que pediria testar tudo de novo ([ADR 0012](0012-installable-app-prepares-songs-locally.pt-BR.md)) |

## Consequências

- Sem framework, as convenções são nossas para escrever e manter: o [`AGENTS.md`](../../AGENTS.pt-BR.md) e a [arquitetura](../architecture.pt-BR.md) as guardam.
- **A API migra para NestJS sobre o Fastify** quando a fase de aprendizado terminar ([ROADMAP](../ROADMAP.pt-BR.md)): os módulos e as convenções do NestJS em cima do mesmo Fastify, na mesma passada da migração da API para TypeScript ([ADR 0011](0011-migrate-javascript-to-typescript.pt-BR.md)). Um ADR novo vai substituir este na parte da API.
- As páginas continuam em React com Vite e o app de computador continua em Electron: os motivos contra Next.js, React Router e Tauri vêm do produto, não da fase de aprendizado.
