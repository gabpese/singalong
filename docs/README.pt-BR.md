# Documentação

[English](README.md) · **Português (Brasil)**

Comece pela [arquitetura](architecture.pt-BR.md) e siga os links de que precisar.

| Documento | O que responde |
|---|---|
| [Arquitetura](architecture.pt-BR.md) | Quais são as partes, como correm um pedido de música e uma Vez, onde cada palavra mora no código |
| [Infraestrutura](infrastructure.pt-BR.md) | Onde roda, como uma mudança chega às pessoas, o que cada ajuste faz |
| [Glossário](GLOSSARY.pt-BR.md) | As palavras do produto: Sala, Anfitrião, Jukebox, Palco, Intervalo... |
| [Roadmap](ROADMAP.pt-BR.md) | O que vem a seguir |
| [Marca](BRAND.pt-BR.md) | Como o Singalong se mostra e fala, e por quê |
| [PRD](PRD.pt-BR.md) | Requisitos do produto |
| [TRD](TRD.pt-BR.md) | Requisitos técnicos e o desenho do app instalável e do agente |
| [PLAN](PLAN.pt-BR.md) | A história: cada fase, decisão e versão |

## Decisões de arquitetura (ADRs)

Cada ADR registra uma decisão e o porquê dela. Para mudar uma decisão, escreva um ADR novo que substitui o antigo.

- [0001. Custo zero enquanto o projeto não gera receita](adr/0001-zero-cost-while-non-profit.pt-BR.md)
- [0002. Um repositório, um app por runtime](adr/0002-monorepo-one-app-per-runtime.pt-BR.md)
- [0003. A API é Node.js com Fastify](adr/0003-node-fastify-api.pt-BR.md)
- [0004. O worker é Python](adr/0004-python-worker.pt-BR.md)
- [0005. Os workers buscam o trabalho; o servidor nunca os chama](adr/0005-workers-pull-jobs.pt-BR.md)
- [0006. O SQLite guarda as Salas e a Fila](adr/0006-sqlite.pt-BR.md)
- [0007. Celulares e TV são páginas web, não apps nativos](adr/0007-web-clients-not-native-apps.pt-BR.md)
- [0008. Letra e tom são desenhados no navegador, não gravados num vídeo](adr/0008-render-lyrics-and-key-in-the-browser.pt-BR.md)
- [0009. O servidor é dono da Sala; a TV é dona do som](adr/0009-server-owns-room-state-tv-owns-sound.pt-BR.md)
- [0010. React, com uma página por tela e sem roteador](adr/0010-react-multi-page-without-router.pt-BR.md)
- [0011. Todo o JavaScript migra para TypeScript, aos poucos](adr/0011-migrate-javascript-to-typescript.pt-BR.md)
- [0012. As músicas são preparadas no computador de cada usuário](adr/0012-installable-app-prepares-songs-locally.pt-BR.md)
- [0013. Uma VM gratuita atrás do Caddy, num endereço do DuckDNS](adr/0013-free-vm-with-caddy-and-duckdns.pt-BR.md)
- [0014. CSS próprio a partir de tokens, sem Tailwind nem kit de componentes](adr/0014-own-css-with-tokens.pt-BR.md)
- [0015. O repositório é escrito em inglês, com traduções em português](adr/0015-english-first-repository.pt-BR.md)
- [0016. Sem framework completo: Fastify, React com Vite e Electron](adr/0016-no-full-stack-framework.pt-BR.md) (a parte da API foi substituída pelo 0017)
- [0017. A API migra para NestJS sobre o Fastify, com MikroORM sobre o SQLite](adr/0017-api-on-nestjs-with-mikroorm.pt-BR.md)
