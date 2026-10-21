# AGENTS.md

[English](AGENTS.md) · **Português (Brasil)**

> Tradução para quem fala português. Os agentes leem o [`AGENTS.md`](AGENTS.md), em inglês, que é a versão de referência.

O Singalong é um karaokê colaborativo hospedado por conta própria: os celulares põem músicas na fila de uma Sala, a TV toca o instrumental com a letra palavra a palavra, e um worker transforma vídeos do YouTube em faixas de karaokê. Leia a [docs/architecture.pt-BR.md](docs/architecture.pt-BR.md) para ver como as partes se encaixam e o [docs/GLOSSARY.pt-BR.md](docs/GLOSSARY.pt-BR.md) para as palavras do produto (Sala, Anfitrião, Jukebox, Palco, Dueto, Intervalo).

## Mapa

| Caminho | O que é | Tecnologia |
|---|---|---|
| `apps/api` | Salas, fila, estado por WebSocket, arquivos de mídia, a API do agente | Node 24, NestJS sobre o Fastify e MikroORM sobre o SQLite ([ADR 0017](docs/adr/0017-api-on-nestjs-with-mikroorm.pt-BR.md)), Redis; compilada pelo `tsc` em `dist/` |
| `apps/web` | Página inicial, Sala (celular), TV, Palco | React + Vite, TypeScript |
| `apps/worker` | Download, separação da voz, alinhamento da letra, exportação em MP4 | Python 3.11, PyTorch |
| `apps/desktop` | O app instalável do dono (bandeja, páginas da TV e do anfitrião embutidas) | Electron; o processo principal roda o próprio TypeScript direto, os preloads e a janela compilam ([ADR 0020](docs/adr/0020-desktop-main-process-runs-typescript.pt-BR.md)) |
| `apps/engine` | Monta o ambiente do worker no computador do usuário | Node, TypeScript rodado direto; `dist/` só para o app de computador ([ADR 0019](docs/adr/0019-engine-runs-typescript-and-compiles-for-the-app.pt-BR.md)) |
| `deploy/` | A VM na nuvem: Caddy, compose, `deploy.sh` | Docker Compose |
| `docs/` | Arquitetura, infraestrutura, ADRs, roadmap, PRD, TRD, PLAN, marca | |

## Idioma

- Escreva tudo no repositório em inglês: nomes, comentários, nomes de testes, documentos, mensagens de commit, títulos e descrições de PR.
- O português vive em dois lugares só: a tradução `*.pt-BR.md` ao lado de cada documento e os catálogos da interface em `apps/web/src/i18n/`. Mantenha o documento e a tradução juntos na mesma mudança.
- Arquivos antigos ainda têm comentários em português. Traduza os comentários de um arquivo na mesma passada em que ele migra para TypeScript ([ROADMAP](docs/ROADMAP.pt-BR.md)).
- O produto fala português: pt-BR é o idioma padrão da interface, e todo texto de tela passa pelos catálogos de idioma (o `pt.ts` define as chaves; o `en.ts` e o `es.ts` precisam ter as mesmas, e o compilador confere).

## Antes de mudar

- **A interface**: leia antes o [docs/BRAND.pt-BR.md](docs/BRAND.pt-BR.md). Cores e fontes vêm dos tokens em `apps/web/src/styles/theme-bridge.css` (o app instalável guarda uma cópia; um teste compara as duas). A biblioteca de músicas prontas se chama **Jukebox**. O texto nunca fala de preço.
- **Uma decisão de arquitetura**: leia os [docs/adr/](docs/adr/). Mudar uma delas pede um ADR novo que substitui o antigo. O trabalho de arquitetura, em ordem, está no [ROADMAP](docs/ROADMAP.pt-BR.md).
- **O que a API envia ou recebe** (o estado da Sala, uma mensagem do WebSocket, uma resposta HTTP que as páginas leem): mude o tipo em `apps/api/src/protocol.ts`. O site o importa como tipo pelo `apps/web/src/lib/types.ts`, então o compilador dele mostra cada página que a mudança alcança.
- **Uma ferramenta ou dependência**: o repositório mantém uma versão por linguagem: TypeScript 7, Node 24, Python 3.11. O TypeScript 7 vem sem API do compilador, então escolha ferramentas que rodem pelo `tsc` ou pelo próprio Node; o CLI do Nest, o ts-node e o ts-morph exigiriam o TypeScript 6 ao lado ([ADR 0017](docs/adr/0017-api-on-nestjs-with-mikroorm.pt-BR.md)).
- **A versão do app**: ela mora em `apps/desktop/package.json` (e no lock), `apps/desktop/src/controller.ts` (`APP_VERSION`) e `apps/worker/singalong_worker/version.py`. Mude as três juntas; um teste confere.
- **Qualquer coisa que custe dinheiro** (uma API paga, um serviço pago): pergunte ao dono antes. O projeto roda a custo zero ([ADR 0001](docs/adr/0001-zero-cost-while-non-profit.pt-BR.md)).

## Verificações

Os comandos são os `scripts` de cada `package.json`. O que eles não contam:

| App | Rodar | Pegadinha |
|---|---|---|
| `apps/web` | `npm test`, `npm run typecheck`, `npm run build`, `npm run e2e` | O servidor dos testes de ponta a ponta serve o `dist/`: faça o build antes. Ele roda a API compilada, então rode antes `npm run build` em `apps/api`. As salas dele nascem com o intervalo desligado; os testes que precisam dele o ligam. Os testes unitários rodam o `src/lib` e o `src/i18n` direto no Node, então os imports ali nomeiam o arquivo `.ts`. O `typecheck` confere as páginas (`tsconfig.json`) e os testes, os testes de ponta a ponta e os configs (`tsconfig.node.json`). |
| `apps/worker` | `python -I -m unittest discover -s tests -t .` | Precisa só de `numpy langdetect websockets yt-dlp` (sem PyTorch). |
| `apps/api` | `npm test` | Ele gera o `dist/` antes: os testes, e os de ponta a ponta do site e do app, importam a API compilada. Mudança de schema é uma migração do MikroORM em `src/database/migrations/`, listada em `src/database/orm.ts`; um teste confere que as entidades batem com o que as migrações criam. |
| `apps/desktop`, `apps/engine` | `npm test` | O app de computador importa o `dist/` compilado do motor (o Node não remove tipos dentro de `node_modules`) e compila os preloads e os `ui/*.ts` em `.cjs` e `.js` ao lado deles (resultado no `.gitignore`: edite o `.ts`). O `npm run build` faz as duas coisas, e os scripts dele o rodam antes. Os testes do próprio motor rodam o `.ts` direto, então os imports dele nomeiam o arquivo `.ts`. O teste de ponta a ponta do app também roda a API compilada. |

O CI ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) roda todos na `main`. A imagem da API só é publicada depois que o CI passa.

## Commits e pull requests

- Mensagem de commit: em inglês, uma ou duas frases. Ela termina na própria mensagem, sem a linha `Co-Authored-By`.
- Trabalhe numa branch (`release/X.Y.Z`, `fix/…`, `docs/…`), abra um PR para a `main` e mescle com merge commit.
- Quando o dono pedir para revisar as edições antes, deixe-as sem commit.

## Release

1. Mude a versão (os três lugares acima) e acrescente a seção "What is new in X.Y.Z" ao `docs/PLAN.md` e ao `docs/PLAN.pt-BR.md`.
2. PR para a `main`; espere o CI passar.
3. Crie a release `vX.Y.Z` no GitHub como **rascunho**, apontando para o merge commit.
4. Gere o instalador do Windows nesta máquina (`npm run dist:win` em `apps/desktop`) e anexe `singalong_karaoke.exe`, `singalong_karaoke.exe.blockmap` e `latest.yml`.
5. Rode o workflow "Instaladores de Linux e macOS" (`release-installers.yml`) com a tag; ele anexa o AppImage, o `latest-linux.yml` e o DMG.
6. Publique o rascunho como Latest quando os seis arquivos estiverem anexados.
7. O dono roda `./deploy.sh` na VM (o deploy automático está desligado) e informa a versão nova na página do administrador. A VM guarda as próprias cópias do `deploy.sh`, do `docker-compose.prod.yml` e do `Caddyfile`: quando uma mudança mexe num deles, baixe-o de novo antes ([infraestrutura](docs/infrastructure.pt-BR.md#os-arquivos-da-vm)).
