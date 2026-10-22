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

[ADR 0017](adr/0017-api-on-nestjs-with-mikroorm.pt-BR.md). A API vai para a VM depois de cada pull request aceito. Até o passo 3 terminar, uma migração mantém toda tabela e coluna que a imagem anterior usa (ela cria tabelas e colunas, ou aperta uma restrição que os dados já cumprem), então a imagem anterior continua rodando sobre um banco já migrado.

1. **Ainda em JavaScript (feito).**
   - Testes de concorrência (`apps/api/test/concurrency.test.ts`) para as regras que leem e depois gravam: músicas adicionadas ao mesmo tempo no limite por pessoa, "a TV terminou" e "o Anfitrião pulou" chegando juntos, uma nota enviada quando a música termina, movimentos ao mesmo tempo, um código de pareamento usado duas vezes, dois inícios de sessão, duas Salas com o mesmo código.
   - A fila por Sala, na ordem de chegada (`src/serial.js`), já cobria as rotas HTTP, o "terminou" e os timers do Intervalo; a nota da TV e as difusões de quem entra e sai da sala agora também passam por ela. O "pular" nomeia a música da tela do Anfitrião, então nunca pula a do próximo cantor; as mudanças de sessão fazem fila por computador; uma reação, um código de Sala e um código de pareamento se resolvem cada um numa única instrução SQL. A reserva de trabalhos dos agentes fica no Redis ou na memória, não no SQLite, então o ORM não chega nela.
   - O `deploy.sh` copia o arquivo do SQLite com `VACUUM INTO` antes de cada deploy e guarda as cinco últimas cópias.
2. **NestJS e MikroORM no lugar (feito).**
   - O Nest sobe sobre a instância atual do Fastify e atende o `/healthz` e o `/readyz`. As outras rotas continuam plugins do Fastify, num contexto próprio que mantém o tratador de erros delas.
   - O MikroORM 7 compartilha a conexão `node:sqlite` do `db.js` (`src/database/sqlite-dialect.ts`), com entidades em `defineEntity` que um teste compara com o schema congelado, e uma migração base que não muda nada.
   - O `tsc` do TypeScript 7 gera o `dist/`; o Dockerfile ganha uma etapa de build; o CI compila a API antes dos testes dela e antes dos testes de ponta a ponta do site e do app. O `buildApp()` agora é assíncrono e continua devolvendo a instância do Fastify.
3. **Um pull request por área,** da menos para a mais concorrida: `release`, `cache-cleaner` e `admin`; `songs`; `agents`; `rooms`. Cada um passa os seus arquivos para TypeScript e para um módulo do Nest, escreve os JSON Schemas com TypeBox e torna as chamadas ao banco assíncronas pelo MikroORM, com um EntityManager derivado por requisição, mensagem do WebSocket, timer e volta do long poll. O `rooms` vem em dois pull requests: as Salas no Nest e no MikroORM, e depois os tipos do protocolo (`state`, `position`, as respostas HTTP) na API, que o site importa com `import type`.
   - **`release`, `cache-cleaner` e `admin`: feito.** Cada chamada ganha o seu EntityManager derivado. A versão publicada do app é lida uma vez ao subir e fica em memória, então as rotas dos agentes continuam lendo-a de forma síncrona. Os arquivos estáticos da página do administrador continuam uma rota do Fastify (o endereço precisa terminar em "/"); a API dela é um módulo do Nest no endereço secreto, com um guard para o token e os limites, TypeBox por meio de um pipe e um filtro que responde um `HttpError` como antes.
   - **`songs`: feito.** Sem trabalho de banco: TypeScript, um controller do Nest, schemas TypeBox e um guard `@RateLimit()` reutilizável. O `SongService` continua sendo criado pelo `app.ts`, porque as Salas também o usam. O pipe valida os schemas TypeBox com o próprio Ajv do Fastify e as mesmas opções, então a conversão de tipos e as propriedades descartadas são idênticas às das rotas do Fastify.
   - **Chaves primárias `NOT NULL`: feito.** O schema do `db.js` declarava `TEXT PRIMARY KEY` sem `NOT NULL`, o que deixa o SQLite guardar um nulo, então as entidades tipavam toda chave como anulável. A primeira migração que muda o schema reconstrói as dez tabelas como o SQLite documenta, com as chaves estrangeiras desligadas fora da transação: ligadas, apagar `rooms` ou `devices` apaga em cascata a Fila, as Sessões e o histórico. Ela mantém as linhas, as restrições `UNIQUE` e `CHECK`, os índices e os contadores do `AUTOINCREMENT`. As migrações agora rodam uma a uma, cada uma na sua transação.
   - **`agents`: feito.** O `AgentService` roda sobre o MikroORM, com um EntityManager derivado por chamada, e todo mundo que o chama espera a resposta: o estado das Salas, as músicas e a página do administrador. O `app.ts` agora cria o MikroORM antes do Nest e roda as migrações antes de qualquer leitura do banco, porque as Salas precisam do serviço antes de o Nest subir. O LegacyModule entrega o MikroORM aos módulos do Nest, então o `@mikro-orm/nestjs` saiu. Dois controllers do Nest atendem o `/agent/v1`. As rotas de pareamento são abertas, e as do computador passam por um guard que confere o token do aparelho. O envio de arquivos para a nuvem continua uma rota do Fastify, com o próprio parser de octet-stream e o limite de 80 MB, e confere o token antes de ler o arquivo. O `@RateLimit()` pode contar só pelo IP, como no pedido de código por e-mail.
   - **`rooms`: feito.** O `RoomService` roda sobre o MikroORM, dentro da mesma fila por Sala, com um EntityManager novo para cada leitura, porque um `nativeUpdate` não atualiza as entidades que um EntityManager já guarda. Dentro de uma transação nada espera outro serviço: a transação segura a única conexão do SQLite até terminar. As rotas HTTP são um controller do Nest. O WebSocket é um gateway do Nest em `/api/rooms/ws?code=…`, com as mesmas mensagens ([ADR 0018](adr/0018-room-websocket-on-a-nest-gateway.pt-BR.md)). O `queue-logic`, o `reactions` e o `serial` viraram TypeScript, o `HttpError` ganhou um arquivo próprio e o `/api/config` foi para o módulo de release. O `db.js` agora só cria o banco e o preenche para os testes.
   - **Os tipos do protocolo: feito.** O `apps/api/src/protocol.ts` define o estado da Sala, as mensagens do WebSocket nos dois sentidos e as respostas HTTP que as páginas leem. A API é tipada por ele: o snapshot, o `personalize`, os eventos do gateway e os controllers. O `lib/types.ts` do site o reexporta com `export type`, então nada da API entra no bundle. As cópias que o site tinha (a configuração da página inicial, o resultado da busca, o estado da exportação) saíram, e as mensagens que a TV e os celulares enviam pelo WebSocket são conferidas contra o `ClientMessage`.
4. **O resto da API, e o `db.js` se aposenta,** em dois pull requests.
   - **Os arquivos compartilhados em TypeScript: feito.** `jobs`, `storage`, `files`, `config`, `mailer`, `version`, `youtube`, `installers`, `logging` e `rate-limit`, com os comentários em inglês. As filas de trabalho no Redis e na memória implementam uma única interface `JobStore`, e a da memória acrescenta o que só os testes usam. O `rateLimited()` do Fastify saiu, porque toda rota com limite agora é do Nest.
   - **O `db.js` se aposenta: feito.** O schema congelado agora é a primeira migração (`Migration20261019000000_initial_schema`), listada antes da base. Ela cria o que falta num banco novo e acrescenta as colunas que faltam num antigo, então, num banco que o db.js já tinha montado, ela roda uma vez e não muda nada. A conexão abre em `src/database/connection.ts`, o `/readyz` pergunta ao MikroORM e os testes preenchem o banco pelo MikroORM (`test/fixtures.ts`). O código da API não tem mais JavaScript, então o `allowJs` saiu.

### 4. O motor (feito)

O teste empacotou arquivos `.ts` com o electron-builder e os rodou no Electron 44 (Node 24.21, com remoção de tipos). O `.ts` do próprio app rodou, empacotado também, mas um `.ts` dentro do `node_modules`, onde o app empacotado guarda o motor, foi recusado. Então o código do motor é TypeScript que o Node roda direto (os testes, o `node src/cli.ts` e o job do CI com o motor de verdade), e o `tsc` gera o `dist/` só para o app de computador, que o importa pelos `exports` do pacote ([ADR 0019](adr/0019-engine-runs-typescript-and-compiles-for-the-app.pt-BR.md)). O app de computador o compila antes de subir, testar ou empacotar, e o instalador leva só o `dist/` e o `manifest.json` dele.

### 5. O app de computador (feito)

O processo principal roda o próprio `.ts` direto, empacotado também, e o `tsc` só confere os tipos dele. Os preloads (`.cts`) e os scripts da janela (`ui/*.ts`) compilam com o `tsc`, cada um ao lado do seu fonte, então o app carrega os mesmos caminhos de antes ([ADR 0020](adr/0020-desktop-main-process-runs-typescript.pt-BR.md)). O `ui/bridge.ts` tipa o contrato entre a janela e o processo principal: o snapshot, as abas e cada ação com o seu argumento e a sua resposta. O `npm run build` compila o motor e a janela antes de o app abrir, testar ou empacotar.

### 6. Os testes (feito)

Os `*.mjs` e `*.test.js` que restam viram `.ts`, num pull request por app. O `tsconfig.json` de cada app cobre os testes e os scripts dele, então o CI confere os tipos deles também.

- **O motor e o app de computador: feito.** O `tsconfig.json` do motor confere `src/` e `test/`, e o `tsconfig.build.json` gera o `dist/`. O do app de computador cobre `src/`, `test/`, `e2e/` e `scripts/`. Os dois arquivos que sobem a API pelo `dist/` compilado (o teste de ponta a ponta e o `scripts/test-update.ts`) a importam sem tipos.
- **O site: feito.** Os testes de unidade, os testes do Playwright (agora com nomes em inglês), o `e2e/server.ts` e os configs do Vite e do Playwright. O `tsconfig.node.json` os confere, ao lado do `tsconfig.json` das páginas. O servidor dos testes de ponta a ponta sobe a API pelo `dist/` compilado, que ele importa sem tipos.
- **A API: feito.** Os testes (agora com nomes em inglês) e o `scripts/copy-assets.ts` são `.ts` sem conferência de tipos, porque os testes importam o `dist/` compilado, que não leva tipos. O script da página do administrador (`src/admin/page/admin.ts`) compila com o `tsconfig.admin.json` (os tipos do navegador) direto no `dist/`, e lê o estado pelo tipo `AdminState` do `protocol.ts`; o `copy-assets.ts` copia só o HTML e o CSS da página.

## Código em inglês

**Obrigatório.** O repositório é primeiro em inglês ([ADR 0015](adr/0015-english-first-repository.pt-BR.md)), mas muitos arquivos antigos ainda têm comentários e nomes de teste em português.

- Traduzir os comentários e os nomes de teste de um arquivo na mesma passada que o migra para TypeScript (acima), para mexer em cada arquivo uma vez só.
- Traduzir o que não vai migrar em pull requests pequenos e próprios: o worker em Python, os componentes TSX, o CSS e os scripts de shell.
  - **O worker em Python: feito.** Os comentários, as docstrings, os nomes de teste e o Dockerfile estão em inglês. O que o dono lê continua em português: as linhas de log (o app do desktop as mostra), a ajuda da linha de comando e as mensagens de erro que um job mostra.
  - **Os componentes TSX: feito.** Os comentários do site estão em inglês, junto com os quatro arquivos `.ts` que a passagem para TypeScript tinha deixado em português (`tv/controller.ts`, `room/useRoomConnection.ts`, `tv/applause-sound.ts`, `ui/useInterlude.ts`). Os rótulos da tela citados num comentário ("Adicionar música") ficam como a tela os mostra.
  - **O CSS: feito.** As folhas de estilo do site e do app do desktop estão em inglês, com as duas cópias do `theme-bridge.css` ainda idênticas. Os comentários que ainda descreviam o visual antigo "Cyber-Club" (rosa-neon, ciano, cartão de vidro, contorno preto no dueto) agora descrevem o que o código desenha.
- O texto da interface continua nos catálogos de idioma, com o português como padrão do produto.

## Infraestrutura quando o projeto gerar receita

[ADR 0001](adr/0001-zero-cost-while-non-profit.pt-BR.md). Quando o Singalong gerar receita, rever as escolhas gratuitas: um servidor pago, um domínio próprio no lugar do DuckDNS, certificados de assinatura para os instaladores e o deploy automático.

## Postgres quando houver mais de um servidor

[ADR 0006](adr/0006-sqlite.pt-BR.md). O SQLite fica enquanto uma instância da API atende todo mundo. O MikroORM ([ADR 0017](adr/0017-api-on-nestjs-with-mikroorm.pt-BR.md)) também fala com o Postgres, então a mudança troca o driver e as migrações, não as consultas.

## Letra e vozes por IA: pausado (custo)

Gerar a letra ouvindo a voz isolada (Whisper), escolher a letra do catálogo pelo áudio e descobrir quem canta cada linha num Dueto. Medido e guardado na branch `release/1.4.0`; pausado porque os melhores resultados dependiam de uma API paga.
