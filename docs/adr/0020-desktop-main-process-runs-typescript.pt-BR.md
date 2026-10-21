---
status: aceito
date: 2026-10-21
supersedes: a parte do app de computador na consequência "Motor e app de computador" do 0017
---

# 0020. O processo principal do app de computador roda o próprio TypeScript, e só os preloads e a janela compilam

[English](0020-desktop-main-process-runs-typescript.md) · **Português (Brasil)**

O teste por trás do [ADR 0019](0019-engine-runs-typescript-and-compiles-for-the-app.pt-BR.md) mostrou que o Electron 44 roda os arquivos `.ts` do próprio app, empacotado também. Isso vale só para o processo principal. O Electron carrega um preload com sandbox como um script CommonJS, sem a remoção de tipos do Node, e os scripts da janela rodam no Chromium, que só roda JavaScript.

Então o app de computador se divide em dois:

| Código | Arquivos | Como roda |
|---|---|---|
| O processo principal | `src/main.ts`, `controller.ts`, `installers.ts`, `library-stats.ts` | Como está: o `main` do `package.json` é `src/main.ts`, e os testes importam o `.ts`. O `tsc -p tsconfig.json` só confere os tipos (`noEmit`, `erasableSyntaxOnly`). |
| Os preloads e a janela | `src/preload.cts`, `src/room-preload.cts`, `ui/*.ts` | Compilados pelo `tsc -p tsconfig.renderer.json`, cada `.cjs` ou `.js` ao lado do seu fonte, para o `main.ts` e o `index.html` carregarem os mesmos caminhos de antes. O resultado fica no `.gitignore`. |

O `ui/bridge.ts` é o contrato entre a janela e o processo principal: o snapshot, as abas e cada ação com o seu argumento e a sua resposta. O `handle()` do processo principal, o preload e o `act()` da janela são tipados por ele, então uma mudança ali aparece dos dois lados. O `npm run build` compila o motor, confere o processo principal e compila o resto. Ele roda antes do `npm start`, dos testes, dos testes de ponta a ponta e do instalador.

## Opções consideradas

| Opção | Por que não |
|---|---|
| **Compilar o app inteiro para `dist/`, como a API** | Um build para o processo principal, que roda o próprio fonte como está, e os testes importariam uma cópia em vez do código que conferem |
| **Compilar os preloads e a janela numa pasta própria** (`out/`) | O `main.ts` e o `index.html` carregariam caminhos diferentes dos fontes; ao lado dos fontes, os caminhos ficam os mesmos no desenvolvimento e no pacote |
| **Um bundler para a janela** (esbuild, Vite) | Uma segunda ferramenta para cinco arquivos que o `tsc` já compila |

## Consequências

- O instalador leva o `.ts` do processo principal e os `.cjs` e `.js` compilados. O `files` dele deixa de fora `src/*.cts` e `ui/*.ts`.
- Depois de editar um preload ou um script da janela, o `npm run build` (ou o `npm start`, que o roda) leva a mudança à janela. O processo principal não precisa de build.
- Um preload é CommonJS. Com `verbatimModuleSyntax` ele importa o Electron com `import electron = require('electron')`.
- O job do app de computador no CI confere os tipos das duas partes nos três sistemas, já que o `npm test` compila antes.
