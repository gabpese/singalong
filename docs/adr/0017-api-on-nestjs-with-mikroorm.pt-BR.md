---
status: aceito
date: 2026-10-20
supersedes: 0016 (na parte da API) e a etapa de build do 0011
---

# 0017. A API migra para NestJS sobre o Fastify, com MikroORM sobre o SQLite

[English](0017-api-on-nestjs-with-mikroorm.md) · **Português (Brasil)**

A fase de aprendizado que o [ADR 0016](0016-no-full-stack-framework.pt-BR.md) esperava terminou. A API migra para NestJS em cima do mesmo Fastify, pelos módulos e pela injeção de dependência. O acesso ao banco migra para o MikroORM 7 sobre o driver embutido `node:sqlite`: entidades, relações, migrações versionadas e um caminho para o Postgres quando houver mais de um servidor ([ADR 0006](0006-sqlite.pt-BR.md)). As páginas continuam em React com Vite e o app de computador continua em Electron, como o ADR 0016 decidiu.

O repositório mantém uma versão de cada linguagem: TypeScript 7 e Node 24. O TypeScript 7 confere e gera os decorators antigos do Nest e os metadados deles, mas vem sem a API do compilador que o `nest build`, o ts-node e o ts-morph importam. Por isso a API compila com o próprio `tsc` do TypeScript 7 para `dist/`, sem o CLI do Nest. As entidades do MikroORM são escritas com `defineEntity`, então nem o provedor de metadados por ts-morph nem decorators são necessários.

Hoje as 145 chamadas ao banco são síncronas, então cada regra da Sala roda até o fim antes de qualquer outra mensagem ser atendida. O MikroORM só funciona de forma assíncrona, e um `await` no meio de uma regra deixaria uma segunda mensagem agir sobre um estado pela metade. Antes de qualquer chamada virar assíncrona, todo comando que muda uma Sala (rota HTTP, mensagem do WebSocket, timer do Intervalo) passa por uma fila, na ordem de chegada, por código de Sala. A maioria já passava, porque achar a próxima música pronta já era assíncrono; o passo 3.1 do ROADMAP trouxe o resto. Regras que cabem numa instrução (um código de pareamento, um código de Sala, uma reação) se resolvem nessa única instrução SQL. A reserva de trabalhos dos agentes fica no Redis ou na memória, fora do SQLite, então o ORM não chega nela. Cada requisição, mensagem do WebSocket, timer e volta do long poll ganha o seu próprio EntityManager derivado, nunca um por conexão, para nenhum contexto viver mais que os dados que guardou.

Os contratos ficam como estão:

- O WebSocket continua uma rota do `@fastify/websocket` em `/api/rooms/:code/ws`, com as mesmas mensagens, registrada a partir de um módulo do Nest.
- A `/agent/v1`, chamada pelos agentes já instalados, não muda.
- Os JSON Schemas continuam, escritos com TypeBox, para o mesmo schema validar a requisição e dar o tipo TypeScript dela.
- O `buildApp()` continua devolvendo a instância do Fastify (agora de forma assíncrona, porque o Nest sobe de forma assíncrona), então os testes com `inject` e os servidores dos testes de ponta a ponta continuam funcionando; eles importam a API de `dist/`.
- Os tipos do protocolo (`state`, `position`, as respostas HTTP) são definidos na API, e o site os importa com `import type`.

As entidades guardam dados e relações explícitas, carregadas com `populate` e nunca de forma preguiçosa (lazy). As regras da Sala continuam nos services, então os testes atuais continuam descrevendo o comportamento.

## Alternativas consideradas

| Alternativa | Por que não |
|---|---|
| **Drizzle 1.0** | A alternativa mais próxima: roda de forma síncrona sobre o `node:sqlite`, então as regras da Sala não precisariam de fila. O driver de `node:sqlite` só existe na versão candidata da 1.0, e ele é uma camada fina, sem unit of work. O MikroORM foi escolhido como o ORM mais completo, aceitando a transição para assíncrono |
| **Prisma 7** | Só tem adaptador para `better-sqlite3` (módulo nativo) ou libSQL; linguagem de schema própria e geração de código; assíncrono |
| **TypeORM** | Só drivers nativos de SQLite; o CLI de migrações costuma rodar pelo ts-node, que precisa da API do compilador; assíncrono |
| **Kysely** | Um query builder, não um ORM; `node:sqlite` só por dialetos de terceiros |
| **SQL escrito à mão** (como hoje) | Já é seguro, porque toda consulta usa parâmetros, mas tipos, migrações e a mudança para Postgres continuam manuais |
| **`nest build` com o TypeScript 6 instalado ao lado do 7** | A configuração que a Microsoft recomenda para ferramentas que precisam da API do compilador; duas versões de uma linguagem |
| **Um gateway de WebSocket do Nest** | O `@nestjs/platform-ws` só aceita caminhos exatos, então o código da Sala sairia da URL e o protocolo da TV e dos celulares mudaria sem ganho |
| **Reescrever a API numa passada só** (o plano do ADR 0016) | Trocado por um pull request por área, cada um verde no CI |

## Consequências

- **Ordem.** Primeiro, ainda em JavaScript: testes de concorrência para cada regra que lê e depois grava, e a fila por Sala. Depois o Nest sobe sobre a instância atual do Fastify, com o MikroORM e uma migração base. Depois um pull request por área, da menos para a mais concorrida: `release`, `cache-cleaner` e `admin`; `songs`; `agents`; `rooms`. Cada um passa os seus arquivos para TypeScript, para um módulo do Nest e para o MikroORM, e traduz os comentários deles. O [ROADMAP](../ROADMAP.pt-BR.md) lista os passos.
- **Base.** O código de inicialização atual (`CREATE TABLE IF NOT EXISTS` e as conferências `hasColumn`) fica congelado: continua criando um banco novo e atualizando um antigo até o `db.js` sair, mas nenhuma mudança entra nele. O MikroORM compartilha a conexão dele, as entidades batem com o que ele cria (um teste compara) e uma migração base que não muda nada fica registrada. Toda mudança de schema depois dela é um arquivo de migração.
- **Voltar atrás.** Enquanto a API migra, as migrações só criam tabelas e colunas, então a imagem anterior continua rodando sobre um banco já migrado. O `deploy.sh` copia o arquivo do SQLite antes de cada deploy, e a API vai para a VM depois de cada pull request aceito.
- **`erasableSyntaxOnly`** vale onde o Node roda `.ts` direto (o `lib` e o i18n do site, o motor, o app de computador, os testes). A API é compilada, então pode usar as parameter properties do Nest.
- **Motor e app de computador.** O [ADR 0011](0011-migrate-javascript-to-typescript.pt-BR.md) espera que eles rodem `.ts` sem build. O Node se recusa a remover tipos dentro de `node_modules`, onde o app empacotado guarda o motor, e o processo principal roda no Node do próprio Electron. Antes de o motor migrar, um teste empacota um arquivo `.ts` com o electron-builder. Se falhar, os dois compilam com o mesmo `tsc` da API.
- **CI e imagem.** O job da API compila antes de testar, os jobs do site e do app compilam a API antes dos testes de ponta a ponta, e o Dockerfile ganha uma etapa de build.
