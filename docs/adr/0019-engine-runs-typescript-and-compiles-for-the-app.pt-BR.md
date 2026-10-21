---
status: aceito
date: 2026-10-20
supersedes: a parte do motor na consequência "Motor e app de computador" do 0017
---

# 0019. O motor roda o próprio TypeScript, e compila só para o app empacotado

[English](0019-engine-runs-typescript-and-compiles-for-the-app.md) · **Português (Brasil)**

O [ADR 0011](0011-migrate-javascript-to-typescript.pt-BR.md) esperava que o motor e o app de computador rodassem `.ts` sem build, e o [ADR 0017](0017-api-on-nestjs-with-mikroorm.pt-BR.md) pôs isso atrás de um teste: se o teste falhasse, os dois compilariam com o mesmo `tsc` da API. O teste empacotou arquivos `.ts` com o electron-builder e os rodou no Electron 44, cujo Node 24.21 remove os tipos:

| Um arquivo `.ts`… | `electron .` | App empacotado |
|---|---|---|
| do próprio app (dentro do `app.asar`) | roda | roda |
| de um pacote em `node_modules`, como o motor chega ao app | roda (um link simbólico) | recusado: `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING` |

Só o import do motor no app empacotado falha. Então o código do motor é TypeScript que o Node roda como está: os testes, a linha de comando (`node src/cli.ts`) e o job do CI que monta um motor de verdade não precisam de build. O `tsc` o transforma em `dist/` só para o app de computador, que o importa pelos `exports` do pacote (`@singalong/engine/assemble`, `/engine`, `/verify`). Os scripts do app de computador o compilam antes do `npm start`, dos testes, dos testes de ponta a ponta e do instalador (`apps/desktop/scripts/build-engine.mjs`). O motor segue as regras do `lib` do site: `erasableSyntaxOnly` e imports que nomeiam o arquivo `.ts`.

## Opções consideradas

| Opção | Por que não |
|---|---|
| **Compilar o motor como a API** (o plano B do ADR 0017): os testes e a linha de comando usam o `dist/` | Um build antes de cada teste e antes do job do CI com o motor de verdade, onde o Node já roda o código-fonte |
| **Manter o `.ts` do motor fora do `node_modules`** (copiá-lo para os arquivos do próprio app ao empacotar) | Roda sem build, mas os caminhos dos imports seriam diferentes no desenvolvimento e no app empacotado |

## Consequências

- O instalador leva só o `dist/` e o `manifest.json` do motor: o `files` do app de computador deixa de fora o `src/` e o `tsconfig.json` dele.
- Quem desenvolve roda o app de computador como antes; o primeiro `npm start` ou `npm test` também instala as ferramentas do motor (o TypeScript e os tipos do Node) e o compila.
- O código do próprio app de computador é decidido no passo 5 do [ROADMAP](../ROADMAP.pt-BR.md). O teste mostra que o processo principal dele pode rodar `.ts` direto. Os scripts de preload (com sandbox) e as telas (um navegador) não podem.
