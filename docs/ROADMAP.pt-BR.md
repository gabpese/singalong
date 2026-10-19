# Roadmap

[English](ROADMAP.md) · **Português (Brasil)**

O que está planejado, sem datas. O que já aconteceu está no [PLAN](PLAN.pt-BR.md).

## Código em inglês

**Obrigatório.** O repositório é primeiro em inglês ([ADR 0015](adr/0015-english-first-repository.pt-BR.md)), mas muitos arquivos antigos ainda têm comentários e nomes de teste em português.

- Traduzir os comentários e os nomes de teste de um arquivo na mesma passada que o migra para TypeScript (abaixo), para mexer em cada arquivo uma vez só.
- Fazer uma passada própria no que não vai migrar: o worker em Python, os componentes TSX, o CSS e os scripts de shell.
- O texto da interface continua nos catálogos de idioma, com o português como padrão do produto.

## TypeScript em tudo fora do worker

[ADR 0011](adr/0011-migrate-javascript-to-typescript.pt-BR.md). Uma linguagem só no lado JavaScript; o worker continua em Python.

1. `apps/web/src/lib` (o site já compila TypeScript)
2. `apps/api`, direto para NestJS (abaixo)
3. `apps/engine`
4. `apps/desktop`
5. Os testes (`*.mjs`, `*.test.js`)

O motor e o app instalável não precisam de etapa de build, porque o Node 24 roda `.ts` direto. Cada passo acrescenta o `tsc --noEmit` ao job de CI daquele app.

## A API em NestJS

[ADR 0016](adr/0016-no-full-stack-framework.pt-BR.md). Quando a fase de aprendizado terminar, a API migra para NestJS em cima do mesmo Fastify, numa passada só com a migração dela para TypeScript e a tradução dos comentários. O NestJS traz uma etapa de build para a API (`nest build`), porque o Node não roda decorators. As páginas continuam em React com Vite e o app de computador continua em Electron.

## O token do aparelho no cofre do sistema

**Segurança.** Depois do pareamento, o app instalável guarda o token do aparelho em texto puro no `config.json`, na pasta de dados do usuário (`apps/desktop/src/controller.js`), enquanto o [TRD](TRD.pt-BR.md) previa o cofre do sistema. Um backup, uma cópia sincronizada dessa pasta ou um disco lido por outra conta expõe o token, e quem o tem age como aquele computador até o dono revogá-lo.

- Criptografar o token com o `safeStorage` do Electron (DPAPI no Windows, Keychain no macOS, o Secret Service no Linux) e guardar só o valor criptografado no `config.json`.
- Na primeira execução depois da atualização, criptografar um token em texto puro encontrado no arquivo e regravá-lo.
- No Linux sem Secret Service, o `safeStorage` usa uma chave fixa: avisar o dono de que ali o token não está protegido.
- Um programa rodando como o mesmo usuário ainda consegue pedir ao sistema que decifre o token, então revogar o aparelho continua sendo a resposta para um computador comprometido.

## Infraestrutura quando o projeto gerar receita

[ADR 0001](adr/0001-zero-cost-while-non-profit.pt-BR.md). Quando o Singalong gerar receita, rever as escolhas gratuitas: um servidor pago, um domínio próprio no lugar do DuckDNS, certificados de assinatura para os instaladores e o deploy automático.

## Postgres quando houver mais de um servidor

[ADR 0006](adr/0006-sqlite.pt-BR.md). O SQLite fica enquanto uma instância da API atende todo mundo.

## Letra e vozes por IA: pausado (custo)

Gerar a letra ouvindo a voz isolada (Whisper), escolher a letra do catálogo pelo áudio e descobrir quem canta cada linha num Dueto. Medido e guardado na branch `release/1.4.0`; pausado porque os melhores resultados dependiam de uma API paga.
