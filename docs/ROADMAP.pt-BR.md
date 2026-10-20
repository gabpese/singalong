# Roadmap

[English](ROADMAP.md) · **Português (Brasil)**

O que está planejado, sem datas. O que já aconteceu está no [PLAN](PLAN.pt-BR.md).

## Trabalho de arquitetura, em ordem

O [ADR 0011](adr/0011-migrate-javascript-to-typescript.pt-BR.md) migra todo arquivo JavaScript fora do worker para TypeScript, e o [ADR 0017](adr/0017-api-on-nestjs-with-mikroorm.pt-BR.md) migra a API para NestJS com MikroORM. O repositório mantém uma versão de cada linguagem: TypeScript 7, Node 24 e Python 3.11.

Cada passo é um pull request (o passo 3 são vários), aceito com merge commit. Só o passo 2 gera uma versão. Um passo acrescenta o `tsc --noEmit` ao job de CI do app que migra e traduz os comentários e os nomes de teste de cada arquivo que migra ([ADR 0015](adr/0015-english-first-repository.pt-BR.md)).

### 1. O `lib` e os catálogos de idioma do site em TypeScript (feito)

- Todo arquivo em `apps/web/src/lib` e `apps/web/src/i18n` vira `.ts`. O `src/vendor` (SoundTouch, qrcode) é código de terceiros e continua em JavaScript, com um `.d.ts` onde precisar.
- Os imports nomeiam o arquivo `.ts` (`allowImportingTsExtensions`), e o `erasableSyntaxOnly` mantém o código executável pelo Node, que roda os testes unitários sem build. Os imports dos testes passam a apontar para `.ts` no mesmo pull request.
- O `pt.ts` define o tipo do catálogo, e o `en.ts` e o `es.ts` declaram `satisfies Catalog`, então o compilador confere as chaves que o teste de idioma confere hoje.
- Os tipos ficam ao lado do seu módulo. As formas que o servidor envia continuam em `lib/types.ts` até o passo 3.
- O `engines` passa a `>=24` em todos os apps.

### 2. O token do aparelho no cofre do sistema, e depois a versão 1.4.2 (feito)

**Segurança.** Depois do pareamento, o app instalável guarda o token do aparelho em texto puro no `config.json`, na pasta de dados do usuário (`apps/desktop/src/controller.js`), enquanto o [TRD](TRD.pt-BR.md) previa o cofre do sistema. Um backup, uma cópia sincronizada dessa pasta ou um disco lido por outra conta expõe o token, e quem o tem age como aquele computador até o dono revogá-lo.

- Criptografar o token com o `safeStorage` do Electron (DPAPI no Windows, Keychain no macOS, o Secret Service no Linux) e guardar só o valor criptografado no `config.json`.
- Na primeira execução depois da atualização, criptografar um token em texto puro encontrado no arquivo e regravá-lo.
- Quando o token não puder ser decifrado (um perfil copiado para outro computador, um chaveiro trocado), o app se considera despareado: apaga o token e volta para o pareamento. O aparelho antigo continua na lista do dono, para ser revogado.
- No Linux sem Secret Service, o `safeStorage` usa uma chave fixa: guardar o token e mostrar no app um aviso permanente de que ali ele não está protegido.
- Um programa rodando como o mesmo usuário ainda consegue pedir ao sistema que decifre o token, então revogar o aparelho continua sendo a resposta para um computador comprometido.

### 3. A API em NestJS e MikroORM

[ADR 0017](adr/0017-api-on-nestjs-with-mikroorm.pt-BR.md). A API vai para a VM depois de cada pull request aceito. Até o passo 3 terminar, as migrações só criam tabelas e colunas, então a imagem anterior continua rodando sobre um banco já migrado.

1. **Ainda em JavaScript.**
   - Testes de concorrência para as regras que leem e depois gravam: duas músicas adicionadas ao mesmo tempo no limite da fila, um avanço duplo quando "a TV terminou" e "o Anfitrião pulou" chegam juntos, um código de pareamento ou um trabalho reservado duas vezes. Eles passam hoje e precisam continuar passando.
   - Uma fila de comandos por Sala, na ordem de chegada, para as rotas HTTP, as mensagens do WebSocket e os timers do Intervalo.
   - `UPDATE`s condicionais para os códigos de pareamento e a reserva de trabalhos.
   - O `deploy.sh` copia o arquivo do SQLite com `VACUUM INTO` antes de cada deploy e guarda as cinco últimas cópias.
2. **NestJS e MikroORM no lugar.**
   - O Nest sobe sobre a instância atual do Fastify; as rotas antigas continuam registradas como plugins do Fastify.
   - O MikroORM 7 sobre o `node:sqlite` (`NodeSqliteDialect`), com entidades em `defineEntity`, e a migração base.
   - O `tsc` do TypeScript 7 gera o `dist/`; o Dockerfile ganha uma etapa de build; o CI compila a API antes dos testes dela e antes dos testes de ponta a ponta do site e do app. O `buildApp()` continua devolvendo a instância do Fastify.
3. **Um pull request por área,** da menos para a mais concorrida: `release`, `cache-cleaner` e `admin`; `songs`; `agents`; `rooms`. Cada um passa os seus arquivos para TypeScript e para um módulo do Nest, escreve os JSON Schemas com TypeBox e torna as chamadas ao banco assíncronas pelo MikroORM, com um EntityManager derivado por requisição, mensagem do WebSocket, timer e volta do long poll. O pull request de `rooms` define os tipos do protocolo (`state`, `position`, as respostas HTTP) na API, e o site os importa com `import type`.

### 4. O motor

Primeiro um teste: empacotar um arquivo `.ts` com o electron-builder e rodá-lo no Electron 44. O Node se recusa a remover tipos dentro de `node_modules`, onde o app empacotado guarda o motor, e o processo principal roda no Node do Electron, não no do sistema. Se o teste rodar, o motor e o app de computador rodam `.ts` direto; se não, os dois compilam com o mesmo `tsc` da API.

### 5. O app de computador

Como o motor, seguindo a resposta do teste.

### 6. Os testes

Os `*.mjs` e `*.test.js` que restarem viram `.ts`.

## Código em inglês

**Obrigatório.** O repositório é primeiro em inglês ([ADR 0015](adr/0015-english-first-repository.pt-BR.md)), mas muitos arquivos antigos ainda têm comentários e nomes de teste em português.

- Traduzir os comentários e os nomes de teste de um arquivo na mesma passada que o migra para TypeScript (acima), para mexer em cada arquivo uma vez só.
- Traduzir o que não vai migrar em pull requests pequenos e próprios: o worker em Python, os componentes TSX, o CSS e os scripts de shell.
- O texto da interface continua nos catálogos de idioma, com o português como padrão do produto.

## Infraestrutura quando o projeto gerar receita

[ADR 0001](adr/0001-zero-cost-while-non-profit.pt-BR.md). Quando o Singalong gerar receita, rever as escolhas gratuitas: um servidor pago, um domínio próprio no lugar do DuckDNS, certificados de assinatura para os instaladores e o deploy automático.

## Postgres quando houver mais de um servidor

[ADR 0006](adr/0006-sqlite.pt-BR.md). O SQLite fica enquanto uma instância da API atende todo mundo. O MikroORM ([ADR 0017](adr/0017-api-on-nestjs-with-mikroorm.pt-BR.md)) também fala com o Postgres, então a mudança troca o driver e as migrações, não as consultas.

## Letra e vozes por IA: pausado (custo)

Gerar a letra ouvindo a voz isolada (Whisper), escolher a letra do catálogo pelo áudio e descobrir quem canta cada linha num Dueto. Medido e guardado na branch `release/1.4.0`; pausado porque os melhores resultados dependiam de uma API paga.
