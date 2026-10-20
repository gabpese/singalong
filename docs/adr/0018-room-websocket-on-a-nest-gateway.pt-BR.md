---
status: aceito
date: 2026-10-20
supersedes: o contrato do WebSocket no 0017
---

# 0018. O WebSocket da Sala é um gateway do Nest

[English](0018-room-websocket-on-a-nest-gateway.md) · **Português (Brasil)**

O [ADR 0017](0017-api-on-nestjs-with-mikroorm.pt-BR.md) manteve o WebSocket da Sala como uma rota do `@fastify/websocket` em `/api/rooms/:code/ws`, porque um gateway do Nest só atende caminhos exatos. Quando todas as rotas HTTP da API passaram para controllers do Nest, essa rota virou o único canal fora dos módulos, da injeção de dependência e dos handlers por mensagem do Nest. O dono escolheu mudá-la.

O WebSocket da Sala é um gateway (`@nestjs/websockets` com `@nestjs/platform-ws`), no mesmo servidor HTTP do Fastify. O código da Sala vai para a query string: `/api/rooms/ws?code=ABCD&role=tv|controller&client=…&host=…&name=…`. As mensagens não mudam. O parser de mensagens do adaptador lê o formato do próprio protocolo, `{ type, ... }`, como o `{ event, data }` do Nest, e o servidor continua enviando `{ type, ... }`. Cada tipo de mensagem tem o seu handler (`hello`, `reaction`, `position`, `lyrics`, `score`, `ended`). O gateway confere se a mensagem veio de uma TV ou de um celular antes de o serviço da Sala agir.

## Opções consideradas

| Opção | Por que não |
|---|---|
| **Manter a rota do `@fastify/websocket`** (ADR 0017) | O mesmo endereço e nenhuma dependência nova, mas o único canal fora do Nest, com a distribuição das mensagens escrita à mão |
| **Um adaptador próprio que aceite `/api/rooms/:code/ws`** | Mantém o endereço, mas sobrescreve a comparação de caminhos interna do adaptador, que uma atualização do Nest pode mudar |

## Consequências

- **O endereço mudou.** As páginas vêm do mesmo servidor, então uma página aberta depois do deploy já usa o endereço novo. Uma página que ficou aberta durante o deploy só reconecta depois de recarregar. O app instalável e o agente não usam esse WebSocket.
- **Dependências.** O `@fastify/websocket` saiu da API. Entraram o `@nestjs/websockets` e o `@nestjs/platform-ws`, na mesma versão do resto do Nest.
- **Limite de frame.** Um frame acima de 1 MB é recusado. A maior mensagem, a letra que a TV envia, fica abaixo de 400 KB.
- **Log.** O pedido de upgrade não passa mais pelo Fastify, então o log de requisições do Fastify não o registra mais, nem o token do Anfitrião no endereço.
- **Testes.** Um teste pode chamar os handlers do gateway com um socket de mentira, sem abrir conexão.
