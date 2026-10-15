# Singalong — Plano de Desenvolvimento

[English](PLAN.md) · **Português (Brasil)**

Sistema próprio de karaokê: cola-se um link do YouTube e o sistema gera a versão karaokê (instrumental + letra sincronizada), com troca de tom e fila colaborativa com pré-processamento em segundo plano.

## 1. Requisitos

| # | Requisito | Decisão |
|---|-----------|---------|
| R1 | Entrada: link do YouTube | Extrair `video_id` (11 chars) como chave de tudo |
| R2 | Letra: usar legenda do vídeo se existir; senão, **seleção obrigatória** de fonte (sem IA de transcrição na v1) | Legenda do YT → LRCLIB → colar `.lrc`/texto manualmente |
| R3 | Vídeo simples (só texto passando) | Ver decisão D1: renderizar a letra **no player**, MP4 é opcional |
| R4 | Pitch shift para quem canta "profissionalmente" | Em tempo real no player, aplicado **só ao instrumental** |
| R5 | Fila colaborativa, próxima música pré-processada em background | Salas + fila persistente + worker consumindo jobs |
| R6 | Cache: mesma música não é reprocessada | Cache por `video_id` em disco + índice no banco |

## 2. Decisões de arquitetura

**D1 — Não renderizar MP4 por padrão.** O pesado (e que vale cachear) é separar o vocal. A letra "passando" é só texto sincronizado: o player da TV toca `instrumental` + `lyrics.json` e desenha a letra com `requestAnimationFrame`. Vantagens: sem etapa de FFmpeg por música, pitch shift trivial (o áudio é independente do vídeo), troca de fonte/tamanho/cor sem reprocessar. MP4 fica como feature opcional (exportar).

**D2 — Pitch shift só no instrumental.** Como o vocal original já foi removido, deslocar o instrumental em ±N semitons é o que o cantor precisa. No navegador: `SoundTouchJS` ou `Tone.PitchShift` (AudioWorklet), mantendo a velocidade. Faixa sugerida: −6 a +6 semitons. O tom escolhido é guardado por item da fila (`pitch`), não no cache.

**D3 — API em Node.js (Fastify) + Worker em Python (decidido).** Fastify (+ Socket.io ou `@fastify/websocket`) cuida de salas, fila, cache e eventos; o worker Python cuida de yt-dlp/Demucs. Os dois conversam por um **contrato simples sobre Redis** (ver seção 13), não por bibliotecas de fila específicas de linguagem.

**D4 — Estado em SQLite no início** (migrar para Postgres se virar multi-servidor). Redis só para a fila de jobs e pub/sub dos eventos.

## 3. Componentes

```
[ Celular (controle) ]──┐
                        ├─ WebSocket/HTTP ─> [ API (FastAPI) ] ──> SQLite
[ TV / Player ]─────────┘                          │
                                              Redis (jobs)
                                                   │
                                          [ Worker Python ]
                                       yt-dlp • demucs • lyrics
                                                   │
                                         /storage/cache/<video_id>/
```

1. **Controle (celular):** entrar na sala (código/QR), colar link, escolher fonte da letra, ver/reordenar/remover fila, escolher tom.
2. **Player (TV):** tela de espera com QR, toca a música atual, desenha a letra, aplica pitch, avisa fim da música.
3. **API:** salas, fila, estado de playback, eventos em tempo real, consulta de cache, disparo de jobs.
4. **Worker:** pipeline de processamento (abaixo).

## 4. Pipeline do worker (por `video_id`)

Cada etapa grava seu artefato e atualiza o status; se o artefato já existe, a etapa é pulada (idempotente, retomável).

1. **Metadados + download** — `yt-dlp`: áudio (`bestaudio` → wav/flac), título/artista/duração, e legendas (`--write-subs --write-auto-subs`? **não**: auto-subs são IA do YouTube e têm timing ruim; usar só legendas manuais por padrão, auto-subs como opção explícita).
2. **Separação** — `demucs` (`--two-stems=vocals`, modelo `htdemucs`) → `instrumental.*` (e opcionalmente `vocals.*` para futura pontuação). Usa GPU se houver; em CPU leva minutos, então a fila e o cache são essenciais.
3. **Letra** — resolver conforme a fonte escolhida:
   - **Legenda do vídeo** (SRT/VTT → normalizar).
   - **LRCLIB** (busca por artista + título + duração; aceita só resultados com `syncedLyrics`, conferir diferença de duração).
   - **Manual** (usuário cola `.lrc` ou texto puro; texto puro sem timing = rejeitado na v1 ou exibido sem sincronia).
   Saída normalizada: `lyrics.json` = `[{start, end, text}]` (linhas; palavras no futuro).
4. **Finalização** — grava `meta.json` (fonte da letra, versão do pipeline, timestamps) e marca `ready`.

### Fluxo de "letra obrigatória"
Se não há legenda no vídeo, o job vai para o status `needs_lyrics`. O celular de quem adicionou mostra a escolha de fonte (LRCLIB com lista de candidatos / colar LRC). O áudio **continua processando em paralelo** — só a letra bloqueia o `ready`.

## 5. Cache

- Chave: `video_id`. Estrutura:
  ```
  storage/cache/<video_id>/
    instrumental.(mp3|flac)
    lyrics.json          # + lyrics.<fonte>.json se houver variantes
    meta.json            # título, artista, duração, fonte da letra, pipeline_version
  ```
- Pronto = existem `instrumental` e `lyrics.json` (não apenas "pasta existe", pois jobs interrompidos deixam pasta parcial). Escrever em `.tmp` e renomear no final.
- **Dedupe de jobs em andamento:** duas pessoas pedindo a mesma música ao mesmo tempo → um único job, ambos os itens da fila apontam para ele (lock por `video_id`).
- Trocar a fonte da letra reaproveita o instrumental (só refaz a etapa 3).
- `pipeline_version` no `meta.json` para invalidar cache quando mudar modelo/parâmetros.
- **Limpeza LRU:** coluna `last_played_at` no banco; job semanal remove os menos recentes quando passar de um limite de disco (nunca remover músicas na fila atual).

## 6. Fila e pré-carregamento

- Estados do item: `pending → processing → needs_lyrics → ready → playing → done | failed | skipped`.
- Ordem de reprodução é independente da ordem de processamento: o worker processa por ordem da fila, mas **prioriza os 2–3 próximos** itens que ainda não estão `ready`.
- A música só é "tocável" quando `ready`. Se o próximo item ainda não estiver pronto, o player pula para o próximo pronto (ou espera, configurável) e o item atrasado mantém a posição.
- Regras de sala: um host com poder de pular/remover; opcional "rodízio justo" (intercala por pessoa para ninguém monopolizar).
- Eventos em tempo real (WebSocket): `queue_updated`, `job_progress`, `now_playing`, `needs_lyrics`.

## 7. Modelo de dados (v1)

- `rooms(id, code, created_at)`
- `songs(video_id PK, title, artist, duration, status, lyrics_source, pipeline_version, last_played_at)`
- `queue_items(id, room_id, video_id, added_by, position, pitch, status, created_at)`
- `jobs` fica no Redis; `songs.status` espelha o resultado.

## 8. API (esboço)

- `POST /rooms` · `GET /rooms/{code}`
- `POST /rooms/{code}/queue` `{url}` → resolve `video_id`, checa cache, cria job se preciso
- `PATCH /rooms/{code}/queue/{id}` `{pitch?, position?}` · `DELETE …`
- `POST /rooms/{code}/player/{play|pause|skip}`
- `GET /songs/{video_id}/lyrics/candidates` · `PUT /songs/{video_id}/lyrics` `{source|lrc}`
- `GET /media/{video_id}/instrumental` (com suporte a Range)
- `WS /rooms/{code}/events`

## 9. Stack

| Camada | Escolha |
|---|---|
| Frontend (controle + player) | React/Vite (ou Svelte) + Web Audio API + SoundTouchJS/Tone.js |
| API | Node.js + Fastify + Socket.io |
| Fila | Redis (Streams ou listas; contrato na seção 13) |
| Banco | SQLite → Postgres |
| Worker | Python: yt-dlp, demucs, ffmpeg, parser SRT/VTT/LRC |
| Deploy | Docker Compose (api, worker, redis); worker com GPU opcional |

Estrutura sugerida do repositório:

```
singalong/
  apps/
    api/        # Fastify (src/routes, src/plugins, server.js)
    worker/     # Python: worker.py (consome fila), pipeline.py
    web/        # controle + player
  packages/     # tipos compartilhados (opcional)
  storage/      # cache (gitignored)
  docker-compose.yml
```

## 10. Fases

**Fase 0 — Spike do pipeline (CLI, sem UI).** `python process.py <url>` → baixa, separa, resolve letra, grava cache. Valida qualidade do Demucs, tempos de CPU/GPU e cobertura do LRCLIB para o seu repertório. *Critério: 5 músicas reais geram instrumental + lyrics.json corretos.*

**Fase 1 — Player isolado.** Página que toca `instrumental` + `lyrics.json` com letra sincronizada e destaque da linha atual, mais slider de pitch. *Critério: cantar uma música inteira em 2 tons diferentes sem dessincronizar.*

**Fase 2 — API + cache + worker integrados.** Endpoint de adicionar link, jobs, status, dedupe, escolha de fonte da letra.

**Fase 3 — Salas e fila.** Controle pelo celular, WebSocket, pré-carregamento dos próximos, pular/remover/reordenar.

**Fase 4 — Robustez (concluída).** Erros do YouTube traduzidos para mensagens claras, retentativas automáticas só para falhas transitórias, proteção contra job que derruba o worker em loop, limite de duração e de disco, limpeza do cache por uso (LRU), limite de requisições, health checks detalhados e logs em JSON. **Postgres opcional ficou de fora**: com uma única instância da API o SQLite basta, e a troca só se justifica junto das várias réplicas (Fase 7).

**Fase 5 — Extras.** Escopo decidido com o dono do projeto:

- **5a. Letra palavra a palavra com tempos reais.** Hoje o destaque das palavras é estimado pelo tamanho do texto dentro da linha. O alinhamento passa a guardar o tempo de cada palavra no `lyrics.json` (`words`), e o player usa esses tempos quando existem (com o cálculo atual como reserva para letras sem eles).
- **5b. Alinhamento forçado por IA.** Já existe (Whisper/stable-ts sobre a voz isolada); aqui entra o refinamento: oferecer o alinhamento também para letras vindas do LRCLIB ou da legenda, para ganhar tempos por palavra.
- **5c. Pontuação por afinação do microfone.** Opcional e **decidida pelo anfitrião** da sala (liga/desliga); sem ele, ninguém usa o microfone.
- **5d. Exportar MP4** da música (instrumental + letra) para rodar o karaokê offline com as músicas que a pessoa já tem.
- **Fora do escopo:** vídeo de fundo.

## 11. Riscos e pontos de atenção

- **Termos do YouTube / direitos autorais:** baixar e remover vocal de conteúdo protegido pode violar os termos do YouTube e direitos autorais. OK para uso pessoal/privado em casa; reveja antes de qualquer uso público ou comercial.
- **yt-dlp quebra com frequência** (o YouTube muda). Fixar versão, atualizar regularmente e tratar falhas de download como erro recuperável.
- **Qualidade da letra:** o timing do LRCLIB é de *outra* gravação; versões ao vivo/remix podem dessincronizar. Mitigar: comparar duração e permitir **offset de letra** (±segundos) por música, salvo no cache.
- **Demucs em CPU é lento** (vários minutos/música). Sem GPU, o pré-carregamento é o que mantém a fila fluindo; limite a concorrência do worker a 1 job de separação por vez.
- **Pitch shift:** acima de ±6 semitons o áudio degrada; e AudioWorklet exige contexto seguro (HTTPS ou localhost) — a TV acessando por IP da rede local precisa de HTTPS ou um cuidado extra.
- **Autoplay do navegador:** o player da TV precisa de um clique inicial para liberar áudio.
- **Latência do WebSocket vs. letra:** a sincronia da letra deve usar `audioContext.currentTime` local do player, nunca eventos de rede.

## 12. Correções sobre o rascunho original

- A função `extrair_youtube_id` do rascunho tinha hostname `'://youtube.com'` (typo) e não tratava `www.youtube.com`, `m.youtube.com`, `/shorts/`, `/embed/`; use regex ou `yt-dlp --get-id` e valide os 11 caracteres.
- "Existe a pasta = pronto" é frágil; usar o critério da seção 5.
- Pitch shift sobre o vídeo original do YouTube deslocaria também o vocal; aqui ele é aplicado ao instrumental.
- Mudar o tom "com FFmpeg em 2 s" no backend é possível, mas exigiria um arquivo por tom; o pitch em tempo real no player evita isso.

## 13. Implantação distribuída (API na AWS, worker com GPU)

Hospedagem proposta: API em EC2 t3.micro, frontend na Vercel/Netlify, worker em máquina com GPU. Isso funciona, mas exige resolver estes pontos:

1. **Arquivos precisam sair do worker.** Se o Demucs roda em outra máquina, o `instrumental` não está no disco da API. O worker deve enviar os artefatos para um **object storage** (S3 ou Cloudflare R2) e a API só guarda o índice; o player toca por URL (pré-assinada ou pública). O disco de 8 GB da t3.micro não serve de cache.
2. **BullMQ não tem consumidor Python maduro.** Usar um contrato próprio: API faz `XADD jobs` (Redis Streams, com consumer group) com `{video_id, url, lyrics_source}`; o worker faz `XREADGROUP`, atualiza `job:<video_id>` (status/progresso) e publica em um canal pub/sub que a API repassa por Socket.io. Alternativa mais simples: o worker chama endpoints HTTP da API (`POST /internal/jobs/claim`, `/progress`, `/complete`) autenticados por token, e o Redis fica só dentro da API.
3. **Worker não aceita conexões de entrada** (Colab/Kaggle e a maioria dos ambientes de GPU): ele deve sempre *puxar* trabalho (long-poll/stream), nunca ser chamado pela API. Expor o Redis publicamente exige senha + TLS; o modelo HTTP com token evita isso.
4. **Colab/Kaggle não são confiáveis como worker permanente:** sessões caem (limite de horas, ociosidade), a GPU não é garantida e há restrições de uso para jobs em segundo plano. Servem para o spike da Fase 0 e testes. Para uso real: máquina própria com GPU (seu PC em casa puxando da API já resolve), instância GPU sob demanda, ou Demucs em CPU com concorrência 1.
5. **yt-dlp em IP de datacenter costuma ser bloqueado pelo YouTube** (AWS, Colab). Opções: baixar na API/máquina com IP residencial, usar cookies de uma conta, ou rodar o worker em casa. Decidir antes da Fase 2.
6. **t3.micro (1 GB RAM, free tier de 12 meses):** Fastify + Redis + SQLite cabem, mas sem Postgres local pesado; mantenha SQLite (arquivo com backup) ou use banco gerenciado.
7. **Segredos e CORS:** `.env` fora do git; CORS restrito ao domínio do frontend; token do worker rotacionável; limite de tamanho/taxa nos endpoints de fila.

## 14. Storage abstrato: local agora, S3/R2 depois

**Modo inicial: tudo na máquina do usuário** (API, worker, Redis e arquivos no mesmo computador; celulares e TV acessam pela rede local). Com isso, na v1 não há EC2, object storage nem exposição de Redis, e o IP do yt-dlp é residencial. A seção 13 passa a valer só quando houver migração para a nuvem.

### Regra de ouro
Nenhum código fora da camada de storage conhece caminhos de disco ou URLs de bucket. O resto do sistema fala em **chaves lógicas**: `cache/<video_id>/instrumental.mp3`, `cache/<video_id>/lyrics.json`, `cache/<video_id>/meta.json`. O banco guarda só a chave, nunca o caminho absoluto.

### Interface (mesma nos dois lados, Node e Python)
```
exists(key)            -> bool
put(key, local_path)   -> void        # worker publica o artefato (atômico: .tmp + rename / multipart)
get_url(key, ttl)      -> string      # URL que o player consegue abrir
read(key)              -> bytes       # para lyrics.json / meta.json pequenos
delete(prefix)         -> void        # usado pela limpeza LRU
list(prefix)           -> [key]
```

### Drivers
| Driver | `get_url` devolve | Observações |
|---|---|---|
| `local` (v1) | `http://<host>:<porta>/media/<key>` servido pelo Fastify com suporte a Range | `put` = mover arquivo para `STORAGE_ROOT/<key>`; bloquear path traversal (`..`) |
| `s3` / `r2` (futuro) | URL pré-assinada com TTL (ou URL pública do CDN) | R2 usa a API S3; mesmo driver com `endpoint` configurável |

Seleção por configuração: `STORAGE_DRIVER=local|s3`, `STORAGE_ROOT`, `S3_ENDPOINT`, `S3_BUCKET`, etc.

### Consequências no resto do plano
- **O worker nunca devolve caminho de arquivo ao job**, só chama `put()` e informa `ready`. A API monta a URL via `get_url()` na hora de entregar a música ao player.
- **Critério de "pronto" (seção 5)** passa a usar `exists(key)` nos dois artefatos, não `os.path.exists`.
- **Worker e API compartilham o driver `local` só se enxergarem a mesma pasta** (mesma máquina ou volume do Docker Compose). Se um dia o worker for para outra máquina, basta trocar para `s3` nos dois lados, sem alterar pipeline, rotas nem player.
- **Limpeza LRU** usa `list`/`delete` do driver; a coluna `last_played_at` continua no banco.
- **Player** só recebe URLs; não sabe se vêm do disco ou do bucket. Com S3/R2, o bucket precisa de CORS liberando o domínio do frontend (necessário para o Web Audio API ler o áudio).
- **Rede local:** o player na TV acessa a API pelo IP da máquina; lembrar do HTTPS/contexto seguro para AudioWorklet (seção 11) ou usar `soundtouchjs` em ScriptProcessor/worklet via `localhost`/túnel.

### Teste de contrato
Escrever uma suíte única de testes (`exists/put/get_url/read/delete/list`) rodada contra o driver `local` e, no futuro, contra o `s3` (com MinIO em Docker). Se o `s3` passar a mesma suíte, a migração é só configuração.

### Plano de migração (quando chegar a hora)
1. Implementar driver `s3` + rodar a suíte de contrato com MinIO.
2. Script `migrate-storage`: percorre `list("cache/")` no local e faz `put` no bucket, verificando tamanho/checksum.
3. Trocar `STORAGE_DRIVER=s3` e reiniciar; manter o disco local como fallback por uma semana.
4. Só então mover API/worker para fora da máquina (seção 13).

## 15. Docker agora, Kubernetes pronto para depois

Princípio: **construir com Docker Compose na v1, mas respeitando desde já as regras que o Kubernetes exige**. Assim, a migração é escrever manifests, não reescrever código.

### 15.1 Imagens e Compose (v1)
Um `Dockerfile` por app, `docker-compose.yml` na raiz:

| Serviço | Imagem | Observações |
|---|---|---|
| `api` | `node:lts-slim`, multi-stage, usuário não-root | Fastify + Socket.io; porta 3000 |
| `worker` | `python:3.11-slim` (CPU) e variante `nvidia/cuda` (GPU) | ffmpeg, yt-dlp, demucs; sem porta exposta |
| `redis` | `redis:7-alpine` | volume para AOF opcional |
| `web` | build estático servido por `nginx` (ou pelo próprio Fastify) | ou hospedado fora |
| `db` (depois) | `postgres:16` | v1 pode ficar em SQLite com volume |

- **Volumes:** `storage` (driver local, compartilhado entre `api` e `worker`), `db`, `redis`.
- **GPU no Windows:** Docker Desktop com WSL2 + NVIDIA Container Toolkit; no Compose, `deploy.resources.reservations.devices` com `driver: nvidia`. Manter perfis (`--profile gpu` / `--profile cpu`) para o worker rodar sem GPU.
- **Cache de modelos do Demucs:** montar `TORCH_HOME` em volume, para não baixar os pesos a cada recriação do container.
- **Desenvolvimento:** `docker-compose.override.yml` com bind mounts e hot reload; produção usa só o arquivo base.
- **Atualização do yt-dlp:** fixar versão na imagem do worker e reconstruir periodicamente (rotina simples, sem atualizar em runtime).

### 15.2 Regras para o código ficar "Kubernetes-ready"
1. **Configuração só por variáveis de ambiente** (12-factor); nenhum arquivo de config dentro da imagem. Segredos (token do worker, credenciais S3) também por env, nunca no repositório.
2. **Nada de `localhost` ou IP fixo:** hosts vêm de env (`REDIS_URL`, `DATABASE_URL`, `PUBLIC_BASE_URL`, `STORAGE_DRIVER`).
3. **Processos sem estado:** API e worker não guardam nada importante em memória ou no disco do container. Estado vai para Redis, banco e storage.
4. **API com várias réplicas:** usar o **adaptador Redis do Socket.io** (`@socket.io/redis-adapter`) para que eventos cheguem a clientes conectados em outra réplica; `sticky sessions` no ingress se usar long-polling (ou forçar só WebSocket).
5. **Banco:** SQLite só funciona com 1 réplica. Já escrever as queries por uma camada de acesso (ex.: Kysely/Drizzle/Prisma) que permita trocar para **Postgres** sem refatorar. Migrar para Postgres antes de subir a segunda réplica.
6. **Storage:** com mais de um nó, o driver `local` deixa de servir (volumes `ReadWriteMany` são frágeis). No K8s o padrão é `STORAGE_DRIVER=s3` (R2/MinIO); o contrato da seção 14 já cobre isso.
7. **Health checks:** `GET /healthz` (liveness: processo vivo) e `GET /readyz` (readiness: Redis/DB alcançáveis) na API; no worker, um heartbeat em arquivo/Redis que o probe consulta.
8. **Encerramento limpo (SIGTERM):** API para de aceitar conexões e fecha sockets; worker termina ou **devolve o job à fila** (não deixa job órfão). Jobs precisam de *visibility timeout* / reivindicação com expiração, para outro worker reassumir se um morrer.
9. **Idempotência:** o pipeline já é retomável por etapa (seção 4); isso é o que torna seguro reiniciar pods.
10. **Logs em stdout/stderr em JSON** (pino no Node, `structlog`/logging JSON no Python), sem arquivos de log; métricas em `/metrics` (Prometheus) quando fizer sentido.
11. **Limites de recursos conhecidos:** medir RAM/CPU/VRAM do Demucs na Fase 0 para preencher `requests/limits` depois.
12. **Concorrência do worker configurável** (`WORKER_CONCURRENCY`, padrão 1): no K8s, escalar = mais réplicas do worker.

### 15.3 Estrutura de repositório adicionada
```
singalong/
  apps/ api/ worker/ web/        # cada um com seu Dockerfile
  deploy/
    compose/                     # base + override + perfis
    k8s/                         # (futuro) base + overlays (kustomize)
      base/    api.yaml worker.yaml redis.yaml ingress.yaml configmap.yaml
      overlays/ local/ prod/
  docker-compose.yml
  .env.example
```
Na v1, `deploy/k8s/` fica vazio ou só com um README; não manter manifests sem uso.

### 15.4 Como seria no Kubernetes (referência)
- `api`: `Deployment` (2+ réplicas) + `Service` + `Ingress` (WebSocket habilitado, timeouts longos).
- `worker`: `Deployment` com `nodeSelector`/tolerations e `resources.limits: nvidia.com/gpu: 1`. **Autoscaling por tamanho da fila** com KEDA (scaler Redis Streams/lista), indo a zero quando a fila está vazia.
- `redis`: serviço gerenciado ou `StatefulSet` simples (a fila é recuperável: jobs perdidos são recriados a partir de `queue_items` no banco).
- `postgres`: serviço gerenciado.
- Config em `ConfigMap`, segredos em `Secret`; imagens com tag por commit.
- Para testar localmente: `kind` ou `minikube`; GPU local em K8s é trabalhosa, então usar o worker em CPU no cluster de teste.

### 15.5 Fases ajustadas
- **Fase 0** (spike CLI) já roda dentro de um container do worker, para fixar dependências e medir recursos.
- **Fase 2** entrega `docker compose up` subindo api + worker + redis funcionando de ponta a ponta.
- **Fase 4** inclui health checks, shutdown limpo, logs JSON e Postgres opcional.
- **Fase 7 (opcional): Kubernetes** — manifests com kustomize, adaptador Redis do Socket.io, driver S3 ativado, KEDA para o worker.

## 16. Estado da implementação

| Fase | Estado | Notas |
|---|---|---|
| 0 — Pipeline (CLI) | ✅ | yt-dlp + Demucs + letra (vídeo/LRCLIB/texto/LRC). Faixa de 3:42 separada em ~8 s numa RTX 3060. |
| 1 — Player isolado | ✅ | Letra sincronizada (preenchimento por palavra), pitch ±6 via AudioWorklet (SoundTouch), ajuste da letra. |
| 2 — API + worker integrados | ✅ | Fastify + Redis Streams + worker consumidor; `docker compose up` sobe tudo. |
| 3 — Salas e fila | ✅ | Salas com código/QR, fila por sala (SQLite), WebSocket, TV + controle + anfitrião, pré-carregamento, rodízio justo. |
| 4 — Robustez | ✅ | Erros traduzidos, retentativas, limites, limpeza LRU, health checks, logs JSON. |
| 5a/5b — Palavra a palavra | ✅ | Tempo real de cada palavra (`words` no `lyrics.json`), também para letras do LRCLIB/legenda; `refresh_words.py` completa o cache antigo. |
| 5c — Pontuação por microfone | ✅ | Anfitrião liga na sala. Ver decisões abaixo. |
| 5d — Exportar MP4 | ✅ | Botão "Baixar MP4" (com escolha de tom) em cada música da biblioteca. Ver decisões abaixo. |
| 6 — Front-end em React | ✅ | Vite + React + TypeScript; entrada, TV e sala migradas, com 63 testes de ponta a ponta. Ver decisões abaixo. |

### Decisões e aprendizados da Fase 2
- **Sem SQLite ainda.** A biblioteca é o próprio cache (`meta.json`); o estado dos jobs vive no Redis (`job:<id>`). O SQLite entra com salas e fila (Fase 3).
- **A API serve o player e o `/media`** (um único servidor, mesma origem). O servidor de teste do `apps/web` foi removido. Não usamos `@fastify/static` (versões 8.x tinham falhas de path traversal); o servidor de arquivos próprio tem Range e testes de traversal.
- **A API monta sempre a URL canônica** do YouTube a partir do ID; o usuário nunca escolhe o alvo do yt-dlp.
- **Dedupe** de jobs no Redis por script Lua atômico: `pending`/`processing` não reenfileiram; `needs_lyrics` só reenfileira com letra nova (`PUT`); `failed` reenfileira com um novo `POST`.
- **`source.json`** guarda os metadados e a legenda do vídeo no cache: trocar a letra não baixa o vídeo de novo.
- **Recuperação de falhas:** o worker lê primeiro suas mensagens pendentes ao subir e reivindica (`XAUTOCLAIM`) as abandonadas há mais de `WORKER_STALE_SECONDS`. Testado com `SIGKILL` no meio da separação: o job terminou ao reiniciar o worker.
- **Armadilha do redis-py:** o `socket_timeout` padrão (5 s) é igual ao `block` do `XREADGROUP`, o que derrubava o worker a cada ciclo ocioso; o worker agora usa `socket_timeout=30`.
- **yt-dlp no container** exige um runtime JS (Deno) e `yt-dlp[default]` para resolver os desafios do YouTube, além de cookies de uma sessão logada.
- **Legenda é opcional, áudio é essencial.** O download do áudio e o da legenda são chamadas separadas do yt-dlp: o YouTube responde `429` ao endpoint de legendas com frequência, e isso não pode derrubar o job. A legenda só é tentada se o vídeo tiver legenda **manual** nos idiomas pedidos; se falhar, o job termina em `needs_lyrics` com uma mensagem própria.
- **Artista/título** valem também no `PUT /api/songs/:id/lyrics`: vídeos sem "Artista - Música" no título precisam deles para a busca no LRCLIB.
- **Pesquisa de vídeos no YouTube** (fora do plano original; adicionada na Fase 2): `GET /api/search?q=`. A API não tem yt-dlp, então o pedido vai por Redis (`search:req` / `search:res:<id>`) para uma **thread própria do worker** (a busca não pode esperar atrás de um job longo de Demucs). Resultados em cache na API por 10 min.
- **"Cantar sem letra"** (`source: none`) garante que qualquer vídeo entra na biblioteca, mesmo sem legenda e sem letra online.
- **Duração da letra online:** o LRCLIB só serve se a duração bater (±5 s). Em covers isso falha com frequência (ex.: cover de 265 s contra versões de 180–213 s). A opção `loose` aceita a versão mais próxima, mas os tempos podem não bater; a solução de fundo é o alinhamento forçado com IA (Fase 5).
- **Legenda do YouTube e HTTP 429:** testado com PO Token (`bgutil-ytdlp-pot-provider`) e impersonation (`curl_cffi`): não resolveu, e a falha também ocorre em outros vídeos, então é limite do YouTube para o IP/conta, não do vídeo. Não adicionamos esses componentes. A legenda segue como fonte oportunista.
- **Alinhamento automático por IA** (antecipado da Fase 5, com aprovação): `lyrics.source = align`. O texto é do usuário; o Whisper (`small`, via `stable-ts`) só marca *quando* cada linha é cantada, ouvindo `vocals.mp3` (a voz isolada pelo Demucs, que passou a ficar no cache). O idioma vem da própria letra (`langdetect`). Medido em "Unethical" contra os tempos do LRCLIB: erro mediano 0,29 s, 49/55 linhas dentro de 1 s, pior caso 1,74 s (vozes de apoio). Custo: primeira vez ~45 s (baixa o modelo, ~460 MB, para o volume `models`); depois ~7 s com a voz em cache. Músicas processadas antes dessa mudança não têm `vocals.mp3`: o worker baixa e separa de novo na primeira vez que alinhar.
- **Serviços externos fora do ar não viram falha do job:** o LRCLIB responde 503 de vez em quando; o worker tenta 3 vezes e, se persistir, o job para em `needs_lyrics` com "tente de novo".
- **Busca de letra pelo Google: não é viável.** Testado: por HTTP simples o Google devolve a página "ative o JavaScript" (sem o painel de letras, `data-attrid="kc:/music/recording_cluster:lyrics"`); com Chrome headless cai em `/sorry` ("unusual traffic", captcha). Além de violar os termos do Google, é frágil. O painel é alimentado pela Musixmatch; o mesmo texto existe no LRCLIB, que é uma API aberta.
- **"Buscar a letra na internet" agora = LRCLIB + IA.** Versão com tempos e mesma duração (±5 s) → usa os tempos prontos (`lrclib`); senão, usa o **texto** do candidato de duração mais próxima e a IA alinha com a voz (`lrclib+align`). A opção "colar texto com tempos de outra fonte" saiu da interface (a API `text` continua e cai para a IA quando não há referência). Músicas antigas, sem `vocals.mp3`, são baixadas e separadas de novo só quando a IA precisa (~30 s a mais, uma vez).
- Indicações de seção como `[Chorus]` são descartadas antes do alinhamento (não são cantadas).

### Decisões e aprendizados da Fase 3
- **Papéis:** a **TV** é o navegador que toca (dona da posição e do evento "terminou"); os **controles** (celulares) adicionam e gerenciam; o **anfitrião** (quem criou a sala, com `host_token`) pula, pausa, reordena e remove de qualquer um. Os demais mexem só nas próprias músicas (identificadas por um `client_id` do navegador, que **nunca** vai nos estados difundidos: cada conexão recebe `mine`/`can_edit` calculados para ela).
- **Comandos por REST, estado por WebSocket.** O WS só empurra o estado e recebe `ended`/`position` da TV (conexões de controle não têm esse poder). REST é idempotente e fácil de testar; o WS reconecta sozinho com recuo exponencial.
- **O servidor decide o que toca.** `tryAdvance` escolhe o próximo item **pronto** (com rodízio justo, se ligado); item ainda em processamento é **pulado e mantém a posição**; um relógio (`tick`, 1,5 s) avança a fila quando o processamento termina e difunde o progresso. Operações de uma sala são serializadas (lock por sala).
- **Pré-carregamento:** o job de processamento começa **na hora em que a música entra na fila** (não quando chega a vez), então a próxima costuma estar pronta quando a atual termina.
- **SQLite embutido (`node:sqlite`)**, sem dependência nativa, num **volume nomeado** (`api-data`): bind mounts do Windows não combinam com arquivos SQLite. O diretório `/data` precisa pertencer ao usuário `node` na imagem.
- **Contexto seguro:** o AudioWorklet (troca de tom) só existe em https ou `localhost`. Por isso a TV deve abrir em `http://localhost:3000`; em http por IP ela toca **sem** troca de tom e avisa. Celulares (só controle) funcionam em http por IP. `crypto.randomUUID` também exige contexto seguro, então o id do navegador usa `crypto.getRandomValues`.
- **QR code** da TV usa `PUBLIC_URL` (endereço do computador na rede); sem ele, usa a origem da página e avisa se for localhost.
- **Bugs que os testes pegaram:** o item que toca vinha depois dos que aguardam (rodízio justo dá posição maior); `append` do DOM imprimia "null" nas partes opcionais; letra da música anterior ficava na tela ao trocar de música.
- **Fora desta fase:** múltiplas réplicas da API (o hub de WebSocket é em memória; passaria a Redis pub/sub), prioridade do worker pela ordem da fila (hoje é FIFO de chegada), HTTPS local para a TV por IP.

### Fase 5c: pontuação pelo microfone
- **Melodia de referência:** o worker extrai o tom da voz isolada (`librosa.pyin`, 1 nota MIDI a cada 50 ms, -1 = sem voz) para `cache/<id>/melody.json`. É opcional: sem ela (cache antigo sem `vocals.mp3`) a música só não pontua. `refresh_words.py` gera a melodia do cache existente.
- **Quem capta:** a **TV** abre o microfone (`getUserMedia`, com cancelamento de eco para o instrumental não contar como voz) e detecta o tom com YIN no próprio navegador; exige `localhost` ou https.
- **A nota:** a música é conferida em **blocos de 2 s, com UMA nota por bloco**. A nota de referência do bloco é a que a original mais sustenta nele (as que ocupam 40% ou mais do bloco são as "principais"); a nota do cantor é a que ele mais cantou no bloco. As duas se comparam ignorando a oitava e com o tom escolhido na música: o crédito cai aos poucos com a distância: 0 e 1 semitom valem tudo, 2 valem 80%, 3 valem 50% e mais que isso nada. Se a original não sustenta nenhuma nota por 40% do bloco, vale a mais frequente. Como o detector de tom falha em muitos quadros de uma voz real (a TV lê o microfone a cada 100 ms e segura a última nota por 150 ms), há uma *participação*: detectar o cantor em 40% das leituras do bloco já vale por inteiro, e a falha do detector não vira erro de quem canta. Só vale com pelo menos 5 s cantados. A nota final é a média dos blocos ponderada pelo tempo com voz na original.
- **Melodia suavizada:** a melodia crua oscila de 4 a 6 vezes por segundo (vibrato, escorregadas, erros do detector). O player a transforma em notas estáveis (mediana, fusão de trechos a até 1 semitom e absorção dos trechos de menos de 0,3 s) antes de escolher a nota do bloco. A melodia da voz original também descarta o vazamento do instrumental e o que fica fora das linhas da letra.
- **Depuração (comentada em `tv.js`; descomente `onBlock` e o `console.table` para ligar):** a TV registra no console do navegador (F12) uma linha por bloco de 2 s fechado, `[pontuação] 00:12–00:14 | original F#4 (principais F#/A) | cantada F#4 | distância 0 → acerto 1 | leituras 14/20 (participação 0.7)`, e uma tabela (`console.table`) com todos os blocos ao fim da música.
- **Calibração por simulação** (melodias reais do cache; cantor ideal que segue a melodia crua, com falhas de detecção): cantar certo ~84–90, nota aleatória ~50, nota fixa ~43, 4 semitons errado ~16, silêncio 0 (um uso real mostrou ~70 antes de afrouxar a queda de crédito). Elevar o limite de "nota principal" derruba tudo junto; 40% foi o ponto que separa melhor quem canta de quem chuta.
- **Servidor:** a sala ganha `scoring` (só o anfitrião muda, `PATCH /rooms/:code`); a TV manda `{type:'score'}` ao fim natural da música (só para o item tocando e com a pontuação ligada) e a nota vai para `queue_items.score` e para o `scoreboard` do estado (10 maiores). O celular mostra o **Placar**; a TV mostra a nota ao vivo e o resultado final por 9 s.
- **Melodia suavizada:** a melodia crua oscila de 4 a 6 vezes por segundo (vibrato, escorregadas, erros do detector), e ninguém canta cada pulo. O player a transforma em notas estáveis (mediana, fusão de trechos a até 1 semitom e absorção dos trechos de menos de 0,3 s): ~0,5 troca por segundo. A TV mostra e compara com essa nota estável.
- **Investigação dos blocos "longe" (4 e 5 semitons), feita com um uso real** (Fresno - Taxista, nota 80; 91 blocos, 13 com 4 a 5 semitons de erro: 6 exatamente uma quinta acima da referência e 3 uma terça maior acima). A régua foi a concordância entre cada versão da referência e as notas que a pessoa cantou (a versão em uso reproduz a nota real: acerto ≤1 semitom 68%, crédito médio 80%). O que foi testado:
  - **Microfone/detector de tom (YIN):** simulado com vozes sintéticas com vibrato, ruído e **sem a fundamental e sem o 2º e o 3º harmônicos**: acertou 99–100% em todos os casos, então o detector não é a causa (a suspeita era ele travar no 3º harmônico, que cai uma quinta acima).
  - **Vazamento de baixo na voz isolada:** existe (em 28–30 s a referência diz B2, o 2º harmônico do baixo B1 do instrumental, com 3× mais energia grave que média), mas filtrar os graves da voz (100 e 150 Hz) ou exigir energia nas frequências médias quase não mexe: concordância 68% → 68%/67%, blocos longe 13 → 13/10; o filtro de 150 Hz ainda esconderia notas reais de vozes graves. **Não aplicado.**
  - **Bloco com mais de uma nota:** só 2 dos 12 blocos longe têm a nota cantada entre as da referência.
  - **Microfone captando o instrumental:** a cantada concorda mais com a voz original (61%) do que com o baixo do instrumental (37%); só 4 dos 15 blocos longe estão perto do baixo. Não é o que explica.
  - **O que sobra** (~14% dos blocos) é compatível com **vozes de apoio e harmonias** (terças e quintas) na gravação, que a voz isolada mistura com a principal, ou com a pessoa cantar outra nota. Só melhora com uma separação que isole a voz principal (ex.: outro modelo de separação), não com ajustes na comparação.
- **Limite conhecido:** é afinação, não ritmo nem letra; barulho forte ou o instrumental vazando para o microfone pode render pontos indevidos.

### Fase 5d: exportar MP4 de karaokê
- **O que sai:** um vídeo 1280×720 (fundo liso) com o instrumental e a letra: o título e o artista no começo, a linha atual em destaque que se **preenche palavra a palavra** (com os tempos reais de `words`; sem eles, estimados pelo tamanho) e a próxima linha em cinza embaixo. Toca em qualquer aparelho, sem a internet e sem o Singalong.
- **Como é feito:** o worker transforma a letra numa legenda **ASS** (efeito `\kf` do karaokê) e o ffmpeg a queima sobre o fundo (`libx264`, `tune stillimage`, ~7 MB por música de 4 min; ~15 s para gerar). A linha aparece 1,5 s antes de ser cantada. Linhas com mais de 70 caracteres usam fonte menor.
- **Tom:** de -6 a +6, trocado com o filtro `rubberband` do ffmpeg (a duração não muda, então a letra continua no tempo). Um arquivo por tom: `cache/<id>/karaoke.mp4` (tom original) e `karaoke_p+2.mp4`, `karaoke_p-3.mp4`...
- **Pedido:** `POST /api/songs/:id/export` `{pitch}` (404 se a música não existe, 409 se ainda não está pronta, 202 gerando, 200 pronta) e `GET /api/songs/:id/export?pitch=` para consultar. O pedido vai por Redis (`export:req`, estado em `export:<id>:<pitch>`) para uma **thread própria do worker**, como a busca: não espera atrás de um job longo de Demucs. O **arquivo existir** é a verdade (o estado no Redis expira em 1 h); pedidos repetidos não duplicam.
- **Limpeza:** os MP4 ficam na pasta da música e saem junto com ela na limpeza do cache por uso.
- **Limites:** fundo liso (vídeo de fundo continua fora do escopo); o MP4 usa a letra e o tom que a música tem no cache no momento do pedido; o ajuste de letra da sala (`lyric_offset`) não entra no vídeo.

### Fase 6: front-end em React
- **Rede de segurança primeiro:** antes de mexer em qualquer tela, 34 testes de ponta a ponta (Playwright, Chromium de verdade) descreveram o comportamento do app que já existia: entrada (4), sala (17) e TV (13). Eles usam só o que a pessoa vê (papéis, rótulos e textos), então rodaram sem mudança antes e depois da migração. O servidor de teste (`apps/web/e2e/server.mjs`) usa a API de verdade com fila de jobs em memória, músicas prontas e microfone falso do Chromium.
- **Estrutura:** Vite com **três páginas** (`index.html`, `room.html`, `tv.html`), então as URLs, o QR code e os links de anfitrião continuam iguais; sem roteador. Código em `apps/web/src`: `landing/`, `room/`, `tv/` (componentes), `lib/` (lógica pura e testada, sem React), `ui/` e `styles/style.css` (o mesmo CSS global de antes). Em `public/` ficam só os arquivos servidos como estão: ícones SVG e o processador do AudioWorklet do SoundTouch, que o navegador carrega por URL.
- **O que foi reaproveitado sem reescrever:** `lyrics-sync`, `queue-view`, `music`, `youtube`, `scoring`, `score-view`, `export-mp4` (lógica pura, com seus testes), o motor de áudio (`engine.js`), a prévia (`preview.js`) e o CSS. São JavaScript com `allowJs`; o código novo (componentes, controlador da TV, tipos do contrato com a API em `lib/types.ts`) é TypeScript estrito.
- **TV:** o motor de áudio e a pontuação são imperativos por natureza (relógio, microfone, AudioWorklet), então ficam num **controlador** (`tv/controller.ts`) que não desenha nada e avisa a tela por callbacks; os componentes desenham a partir do estado. As quatro linhas da letra pertencem ao motor (ele desenha cada palavra com o seu preenchimento): o React só entrega os elementos.
- **Sala:** o estado vem de um hook (`useRoomConnection`: WebSocket com reconexão e a posição da música); as ações passam por um contexto (`act`, avisos, nome); a prévia é o hook `usePreview`; o painel de adicionar é um componente com estado próprio e uma função `chooseLyrics` exposta para a fila. Os ajustes do anfitrião (rodízio, pontuação) valem na hora e só voltam atrás se o servidor recusar.
- **Build e Docker:** `vite build` gera `apps/web/dist`; a imagem da API tem uma etapa que constrói o front-end e copia o `dist` (a API serve esse diretório; `PUBLIC_DIR` o troca). `npm run dev` abre o Vite com proxy para a API.
- **Busca livre e confirmação:** como no YouTube, a pessoa procura pelo **artista, pelo nome da música ou pelos dois** (basta um; `buildSearchQuery` junta como "Artista - Nome" ou usa o que houver), e os campos não têm exemplos. Depois de **escolher o vídeo** (ou colar o link) o painel pede para **confirmar o artista e o nome da música**, os dois obrigatórios, porque alimentam a busca da letra e o que aparece na fila. A confirmação vem preenchida: o que foi digitado na busca vale mais, e o que faltar sai de um palpite do título do vídeo (`guessArtistTitle`: separa em " - " e tira enfeites como "(Official Music Video)" e "[OFFICIAL VIDEO]"). Ao trocar a letra de um item já na fila, a busca some e só a confirmação aparece.
- **Jukebox ao adicionar:** ao buscar um vídeo, antes de ir ao YouTube o painel confere se o que foi digitado bate com músicas **já prontas** (`findJukeboxMatches`: todas as palavras digitadas, inteiras, sem acento nem pontuação, no artista, no título ou no título do vídeo; basta um dos campos, e sem nenhum não sugere nada). Se houver, abre um `<dialog>` ("Encontramos esta versão pronta no nosso Jukebox, quer selecioná-la?" ou, com várias, "...estas versões... quer selecionar uma destas?") com as opções e dois botões: usar a escolhida (entra na fila na hora, como na aba Músicas) ou "Buscar outra versão no YouTube" (segue a busca e não pergunta de novo para o mesmo artista e nome). Esc ou clique fora fecham sem fazer nada.
- **Título original do vídeo:** o `meta.json` guarda também `video_title` (o nome do vídeo no YouTube, ex.: "Faouzia - Unethical (MAPHRA Vocal Cover)"), além do artista e da música que a pessoa informou. A busca do Jukebox e o filtro da biblioteca olham os três, então quem pede "Maphra + Unethical" acha uma música guardada como "Faouzia + Unethical", e o aviso mostra "No YouTube: ..." para distinguir as versões. Músicas antigas ganham o título por um backfill do worker (copia do `source.json` na subida, antes do backfill do tom; os dois reescrevem o mesmo `meta.json`, então rodam em sequência).
- **Controles do player no celular:** o "voltar/avançar 10 s" deu lugar a uma **barra de posição arrastável** (só para o anfitrião; os demais veem a barra de progresso): ao soltar, o celular manda `POST /player/seek {to: segundos}` e a TV vai para esse ponto (o servidor também aceita o salto relativo `{seconds}`; os dois são exclusivos). A barra mostra o destino na hora e segue a música daí. Pausar/retomar, pular, e os botões de tom (− e +, também na prévia) usam os ícones próprios (`pause`, `resume`, `next-song`, `minus`, `plus` em `public/icons`), desenhados como máscara como os demais; o nome fica no `aria-label` e no `title`.
- **Biblioteca no celular:** o item tem a música e o "Adicionar" na primeira linha e, abaixo, uma faixa "Vídeo MP4 para cantar offline" com o tom e o botão de baixar num controle só.
- **Fora desta fase:** Tailwind e CSS por componente (o CSS global continua; o teste `css.test.mjs` impede nomes de classe repetidos), roteador e React StrictMode.

### Controle de nível das vozes de apoio (backing vocals)
- **Ideia:** ao lado do tom, uma barra de 0 a 100% para deixar as vozes de apoio da gravação passarem junto do instrumental. Quem a controla é **quem escolheu a música** (e o anfitrião), igual ao tom; o padrão é 0 (tudo como antes).
- **Separação (worker):** o Demucs só entrega "voz" e "instrumental", e a voz mistura a principal com as de apoio. Um segundo passo usa um modelo de **karaokê do UVR** (`UVR_MDXNET_KARA_2`, MDX-Net, ~53 MB, baixado na primeira vez para o volume `/models`) sobre a `vocals.mp3`: o que ele chama de "Vocals" é a voz principal e o "Instrumental" são as vozes de apoio, gravadas em `cache/<id>/backing.mp3` (MP3 128 kbps). O pacote `audio-separator` (versões fixas no Dockerfile) é instalado com `--no-deps`, porque uma dependência (`diffq`, só dos modelos Demucs) precisa de compilador.
- **Não segura a música:** ela fica pronta sem o apoio; uma **thread própria** (`backing.py`) analisa depois, uma por vez (`backing:req` no Redis; ao subir, também as músicas antigas sem análise). Leva ~1 a 1,5 min por música em CPU. O resultado fica no `meta.json` (`backing: {status: ready | none, share}`): se em menos de 5% dos trechos com voz principal o apoio chega a -15 dB dela (uma voz só, como um cover), a música é marcada `none`, não ganha o arquivo e a barra nem aparece. Medido: "Taxista" (Fresno, com harmonias) 26% e "Unethical" cover (uma voz) 0%; a soma principal + apoio reconstrói a voz original com erro de -40 dB.
- **Várias tarefas escrevendo o `meta.json`:** título do vídeo, tom e apoio completam o meta de músicas já prontas. Cada uma lia o arquivo inteiro, mudava e gravava (a mais lenta sobrescreveria as outras), então passaram a usar `update_meta` (`meta_store.py`): a leitura acontece dentro de uma trava, e o cálculo demorado fica fora dela. Refazer a letra de uma música também preserva o `backing` do meta.
- **API:** `queue_items.backing` (inteiro 0..100); `PATCH /rooms/:code/queue/:itemId` aceita `{pitch?, backing?}` (pelo menos um; só o dono do item ou o anfitrião); `song.media.backing` traz a URL só quando o arquivo existe.
- **TV (`engine.js`):** um segundo `<audio>` com o apoio entra na **mesma entrada do SoundTouch** (por um `GainNode`), então o apoio muda de tom junto. Só baixa o arquivo quando o nível passa de 0, acompanha play/pausa/salto do instrumental e é **realinhado a cada 0,5 s** se escorregar mais de 80 ms (dois elementos de áudio nunca andam exatamente juntos). Sem o grafo de áudio (http fora de localhost) o volume do próprio elemento faz o papel.
- **Celular:** `BackingControl`, uma barra no cartão "Tocando agora" e em cada item da fila, só nas músicas com apoio; quem não é o dono vê o valor.
- **O volume do elemento vale antes do grafo de áudio (defeito encontrado em uso real):** com o nível em 0 ao ligar a TV, o grafo ainda não existe e o motor zerava o `volume` do próprio `<audio>` do apoio; depois, com o grafo pronto, só o `GainNode` passava a ser ajustado e o elemento ficava **mudo para sempre**: a barra mudava o estado e nunca o som. Corrigido (com o grafo, o volume do elemento fica em 1 e quem manda é o ganho). Os testes só olhavam o estado do elemento, então ganharam um teste que **mede o som de saída** (um analisador ligado ao destino; o apoio de teste é um tom de 440 Hz contra 220 Hz do instrumental, para a soma ser mensurável: 100% = +3 dB, 50% = +1 dB, voltar a 0% = nível base), validado antes da correção (falhava com razão 1,003). Com a "Taxista" real: 100% = +4,6 dB, 50% = +1,6 dB, deriva de sincronia de 3 ms.
- **O apoio é baixo em relação ao instrumental:** na "Taxista" ele fica em mediana 28 dB abaixo do instrumental (nos melhores trechos, 6 a 11 dB abaixo): 100% é o equilíbrio da gravação original, então o efeito é sutil na maior parte da música.
- **Armadilha do torch na imagem do worker:** o `onnx2torch` exige o `torchvision`, e o `torchvision` mais novo puxa o **torch 2.14 com CUDA 13** (+4 GB), que **quebra o Demucs** (fixado em torch/torchaudio 2.5.1). Uma primeira versão da imagem fez isso sem avisar e levou a imagem de ~3 GB para 18,8 GB, o que encheu o disco do Windows e travou o Docker. Agora o `torchvision==0.20.1` entra antes, pelo mesmo índice do torch, e a última linha do passo **falha o build** se a versão do torch mudar.
- **Limites:** o apoio nunca é perfeito (em volume alto pode vazar um "fantasma" da voz principal); a **prévia no celular e o MP4 exportado** não incluem o apoio; a pontuação continua comparando com a melodia da voz inteira.

### Marco M0: API do agente local (Out/2026)
Primeiro marco do plano do instalador ([TRD](TRD.pt-BR.md), seção 12). Nada muda para o jeito clássico (worker no Docker lendo o Redis); as salas **sem sessão** se comportam exatamente como antes.
- **`Backend` no worker:** o `runner`, a busca, a exportação e a thread das vozes de apoio não conhecem mais o Redis. O `RedisBackend` mantém o comportamento antigo; o `HttpBackend` é o agente: pega jobs, buscas e exportações em `/agent/v1` por long-poll, envia o progresso e o estado final, e mantém um sinal de vida para a sala mostrar o dono como online durante um job longo. Os estados finais são repetidos em falhas de conexão (perdê-los deixaria o job esperando 30 minutos); os avisos de progresso, não.
- **Sessões no servidor:** tabelas `devices`, `pair_codes` e `sessions`, `rooms.session_id`, e streams do Redis por sessão (`jobs:s:<sessão>`, grupo `agents`, consumidor = id do dispositivo). O contador `starts` do job, a proteção contra "job que derruba o worker em loop" e o prazo de "sem sinal" continuam valendo.
- **Roteamento:** `rooms.add` usa a sessão da sala; a busca, a troca de letra e a exportação usam o código da sala enviado em `X-Room`. Com o dono offline a busca falha na hora com uma mensagem clara; os jobs esperam.
- **Um defeito real que a verificação ponta a ponta achou:** um job `pending` deixado no Redis por uma execução anterior que caiu (o dono nunca voltou) bloqueava todo pedido novo da mesma música (a deduplicação está certa, o órfão não). Correção: um pedido pendente com um dono sem sinal é liberado quando outra pessoa pede a música, e a mensagem antiga é descartada se esse dono voltar. Lição: a execução entre linguagens (API em Node + Redis + agente em Python) pegou o que os testes unitários não pegariam.
- **Armadilhas:** o Ajv do Fastify descarta campos extras do corpo em vez de rejeitar (por isso o servidor aceita uma lista fixa de campos); `XREADGROUP` com id `0` devolve primeiro as mensagens pendentes do próprio consumidor (é a recuperação no reinício, e por isso o agente só chama `claim` quando está ocioso); um `inspect.py` esquecido numa pasta de rascunho sobrepôs a biblioteca padrão quando um script rodou de lá (rode scripts de apoio com `python -I`).

### CI/CD e hospedagem (nuvem gratuita)
- **CI no GitHub Actions:** API (testes), front-end (TypeScript, unitários, build e **ponta a ponta com Playwright**), worker (só `numpy` e `langdetect`, sem o torch) e o build das imagens (a do worker só na `main`, por demorar). Passou de primeira no PR #1.
- **O que dá para hospedar de graça (pesquisa de out/2026):** só **API + Redis + a biblioteca já pronta**. O **worker não cabe**: o YouTube bloqueia IPs de datacenter ("Sign in to confirm you're not a bot") e cookies muitas vezes não resolvem, além de separar voz e alinhar letra serem pesados em CPU. Música nova continua sendo processada no PC de casa. A Oracle Always Free [cortou o ARM grátis para 2 CPUs e 12 GB em jun/2026](https://infoq.com/news/2026/07/oracle-cloud-free-tier-limits/), exige cartão para o cadastro e às vezes está sem capacidade; Render grátis dorme e perde as salas; Fly.io não tem plano grátis.
- **Desenho (pasta `deploy/`):** uma VM Ubuntu com Docker Compose: **Caddy** (HTTPS automático com um subdomínio grátis do DuckDNS, obrigatório para a troca de tom e o microfone) → **API** → **Redis**; só 80 e 443 ficam expostas. A imagem da API é construída pelo CI para **amd64 e arm64** (o front-end é compilado uma vez, na máquina do CI, com `--platform=$BUILDPLATFORM`; só as dependências do servidor são montadas por arquitetura) e publicada no GHCR. O deploy é por SSH (`deploy.sh`), ligado pela variável `DEPLOY_ENABLED`; sem ela o workflow só publica a imagem.
- **Direitos autorais:** o repositório é **público**, então as músicas (`storage/`) nunca vão para o GitHub nem para a imagem: `deploy/sync-library.sh` as copia por SSH, só o que a nuvem precisa para tocar (sem a voz isolada e o `source.json`), para a VM privada. A limpeza do cache fica desligada na nuvem (`CACHE_MAX_GB=0`), porque não há worker para refazer o que fosse apagado.
- **Cookie do YouTube:** hoje o worker o envia em **toda** busca e download. "Entrar com o YouTube" não resolve (o OAuth do Google dá um token de API, não o cookie de sessão que o `yt-dlp` usa) e pedir o cookie de outras pessoas é arriscado (dá acesso à conta inteira): descartado. Melhorias possíveis: usar o cookie só como último recurso (tentar sem ele primeiro) e usar uma conta secundária.
- **Medido na VM gratuita (out/2026):** com o yt-dlp mais recente, sem cookie, pelo IP da Oracle, a busca funciona mas os downloads são quase todos bloqueados (0 de 8 vídeos com o cliente padrão, 1 de 8 com `tv_embedded`): trocar o cliente do yt-dlp não resolve um bloqueio por IP.
- **Próximo passo possível:** armazenamento compartilhado (S3/R2) para o worker de casa abastecer a nuvem sozinho, sem copiar a biblioteca à mão (hoje o driver de armazenamento da API é só o local).

### Fase 3b: tom, prévias, próximo cantor e novo layout
- **Detecção do tom** (`worker/key.py`): perfil de croma do **instrumental** (librosa: HPSS + `chroma_cqt` com a afinação do arquivo compensada) correlacionado com os 24 perfis de Krumhansl-Kessler. Gravado em `meta.json` (`key: {tonic, mode, score, margin, alt}`); músicas antigas ganham o tom em segundo plano na subida do worker (~10 s cada). Validação: áudio sintético **24/24** tonalidades; em músicas reais, a coerência ao transpor foi **19/24** no método atual (empatado com STFT e melhor que CENS e CQT sem HPSS). Os erros se concentram nas músicas ambíguas (maior × relativa menor), e a **margem entre a 1ª e a 2ª tonalidade** prevê isso: abaixo de **0,08** a tela diz "Tom provável: X ou Y" em vez de fingir certeza. É uma estimativa, não uma verdade musical.
- **Próximo cantor:** `next_item_id` no estado da sala, calculado pela **mesma regra** que avança a fila (música pronta + rodízio justo). A TV mostra "Cantando agora → Próximo"; o celular, "Próximo: …".
- **Prévias:** (1) do **vídeo** original, com o player incorporado do YouTube (domínio sem cookies de rastreio), por resultado de pesquisa ou link colado; (2) do **instrumental com tom** no celular, com a versão do SoundTouch baseada em `ScriptProcessor` (a do AudioWorklet só existe em https/localhost; o celular entra por http no IP da rede). Custo: decodifica a música inteira em memória. Uma prévia por vez; ela fecha se a música começa a tocar na TV.
- **Layout:** celular com barra de abas (Fila / Adicionar / Músicas), barra superior fixa com menu ⋯, prévia fixa acima das abas, alvos de toque de 44 px e áreas seguras do iPhone; TV com cabeçalho "cantando agora / próximo", tom e barra de progresso. O front-end é **HTML + CSS + JavaScript puro (módulos ES), sem framework nem build**, servido pela própria API.
- **Bug pego pela revisão visual:** classes `.now`/`.next` colidiam entre a TV, o card do celular e a letra.
- **Em aberto:** a TV aberta por IP (http) ainda toca sem troca de tom; usar o mesmo SoundTouch de `ScriptProcessor` nela resolveria, ao custo de decodificar a música inteira na TV.

### Fase 3c: tom só como nota, lista na TV e "ceder a vez"
- **Tom só como nota** ("Lá (A)", "Dó♯ / Ré♭ (C#/Db)"): o modo (maior/menor) não aparece, porque não muda ao transpor e o que a pessoa precisa é da nota. A detecção continua guardando o modo no `meta.json`. A dúvida só é mostrada quando a alternativa tem **outra nota** (Fá maior × Ré menor → "Fá (F) ou Ré (D)"); Dó maior × Dó menor tem a mesma nota, então não há dúvida a mostrar.
- **Lista na TV:** a música atual + as **5 próximas na ordem em que vão tocar** (o próximo escolhido pelo servidor vem na frente, respeitando o rodízio justo) + "+ N na fila". A tela de espera deixa a lista à mostra.
- **Ceder a vez:** `POST …/move {direction: "down"}` agora também é permitido ao **dono** da música (adia uma posição); `up` continua só do anfitrião. O celular mostra "⇩ Ceder a vez" nas músicas da própria pessoa e a etiqueta "Próximo" no item que toca a seguir. Limitação: a troca é com o vizinho na ordem da fila; com o rodízio justo ligado, o "próximo" pode não ser o vizinho de baixo.

### Fase 3d: aviso de pausa na letra
- **Aviso `--------------`** (14 traços) na TV, no lugar da linha atual, em pausas de **≥ 8 s** (`MIN_GAP_SECONDS`): introdução (conta desde 0), solos e pontes. Nos últimos **8 s** (`COUNTDOWN_SECONDS`) os traços vão sumindo (14 → 1), para o cantor saber **quando** a linha entra; a próxima letra já aparece embaixo. Sem aviso depois da última linha. Lógica pura e testada em `lyrics-sync.js` (`gapDisplay`).
- **Pausas escondidas no LRC:** o LRC só marca o início de cada linha, então o `end` de uma linha é o início da seguinte e um solo "mora" dentro da linha anterior (visto em "O Cantor e o Taxista": uma "linha" de 17,7 s). `sungEnd` estima o fim cantado (`0,12 s × letras + 2 s`, mínimo 3 s) e só corta linhas com mais de **1,5×** essa estimativa; as demais mantêm o `end` original. Isso vale também para o preenchimento da linha, que deixou de "se arrastar" pelo solo. É uma heurística: um trecho muito longo e genuinamente cantado (> 1,5× a estimativa e mais de 8 s além dela) pode receber o aviso por engano.
- Nas 5 músicas da biblioteca: aviso na introdução de todas (11–16 s) e nos 2 solos de "O Cantor e o Taxista" (50–64 s e 98–116 s).

### Fase 3e: adicionar por Artista + Nome da música
- **Artista e Nome da música obrigatórios** no formulário (antes eram opcionais): **`Artista - Nome`** pesquisa o vídeo no YouTube (`buildSearchQuery`) e os mesmos dois campos alimentam a busca da letra (LRCLIB) e o que aparece na fila. O link do vídeo ficou como alternativa recolhida ("Já tenho o link do vídeo"). A letra padrão passou a ser "Buscar a letra na internet".
- **Regra também no servidor:** música ainda não processada sem artista **e** nome → `400 artist_title_required`. Músicas já prontas (biblioteca) dispensam, pois têm os dados no `meta.json`. Espaços das pontas são removidos.
- **Google + Musixmatch como fonte da letra: descartado.** O Google barra acesso automatizado (captcha) e a API oficial da Musixmatch no plano gratuito devolve só **30% da letra** (uma prévia); a letra inteira exige licença comercial paga. O LRCLIB continua sendo a fonte do **texto**; os tempos vêm dele (se a duração bate) ou da IA. Se um dia houver uma chave paga da Musixmatch, o ponto de encaixe é `online_lyrics` em `pipeline.py`.
- **Bug pego pelo teste de ponta a ponta com captura de tela:** `.picked-box { display: flex }` (e `.check`, `.results`...) **sobrescrevia o atributo `hidden`**, deixando caixas "ocultas" visíveis (inclusive o botão do rodízio justo para quem não é anfitrião). Correção: `[hidden] { display: none !important }`. Lição: os testes passaram a verificar `getComputedStyle(...).display`, não só a propriedade `hidden`.

### Fase 3f: filtro da biblioteca
- **Filtro por artista e nome** na aba "Músicas já processadas" (`filterSongs`, `queue-view.js`): sem diferenciar maiúsculas nem acentos (`normalizeText`, NFD), várias palavras em **qualquer ordem** e **todas** precisam casar; contador "N de M"; mensagem e botão "Limpar filtro" quando nada combina. O filtro sobrevive às atualizações da lista. Feito no navegador (a biblioteca é pequena e já vem inteira de `GET /api/songs`); se passar de algumas centenas de músicas, vale mover para o servidor.
- A lista passou a vir **em ordem alfabética** por artista e depois por nome (`sortSongs`), com as sem artista no fim. Um `\u0000` como separador na chave de ordenação era ignorado pela comparação por idioma e embaralhava a ordem: o teste pegou; agora é um comparador de verdade (`Intl.Collator`).
- Armadilha do teste: uma verificação com `|| true` passava mesmo errada; foi reescrita para falhar se o filtro não ignorasse acentos.

### Fase 3g: ícones SVG no lugar dos emojis
- **Ícones próprios** (`public/icons/*.svg`, fornecidos pelo projeto): `singing` (cantor: topo da sala, abas, linhas da fila e cabeçalho da TV), `add-song` (aba Adicionar), `musics` (aba Músicas), `link` (Copiar link da sala), `host` (Copiar link de anfitrião), `display` (Abrir TV e o status "TV conectada"), `search` (Buscar no YouTube). Nenhum emoji colorido restante na interface.
- **Como são desenhados:** como **máscara CSS** (`mask-image` + `background-color: currentColor`), então herdam a cor do texto (dourado na aba ativa, cinza nas outras) em vez de ficarem pretos. Helper `icons.js` (`icon(nome)`) para o JavaScript; `<span class="icon i-nome">` no HTML.
- Símbolos de texto que não são emoji colorido seguem (▲ ▼ ✕ ⋯ ⛶). Os rótulos "Pausar", "Retomar", "Pular", "Prévia" e "Ceder a vez" perderam os glifos ⏸ ▶ ⏭ ⇩; o botão de tocar/pausar da prévia usa ▶/⏸ com U+FE0E, que força a versão em texto (sem ele alguns celulares desenham o emoji).
- **Etiqueta "Próximo" gigante:** colisão de nome de classe: `.chip.next` herdava a fonte enorme de `.next` (a próxima linha da letra na TV). Virou `.chip.is-next`. No mesmo passe: `.singer` do celular herdava o `display:grid` do `.singer` da TV (o ícone ficava sozinho numa linha) e virou `.now-singer`.
- **Guarda automática:** `test/css.test.mjs` falha se uma classe simples for definida duas vezes no CSS (a causa das três colisões da Fase 3: `.now`, `.next` e `.singer`); foi verificada reintroduzindo uma colisão de propósito. Também confere que cada ícone declarado aponta para um SVG existente e que `[hidden]` vence os `display`. O teste de ponta a ponta confere que não sobra `\p{Emoji_Presentation}` na tela e que cada ícone carrega a máscara e tem tamanho visível.

### Roteiro futuro: migração do front-end para React
Decidido com o dono do projeto: **seguir com HTML/CSS/JS puros até fechar a Fase 4 e migrar para React depois** (Fase 6). Motivos e cuidados:
- **Por que React:** `room.js` e `tv.js` redesenham a tela à mão a partir do estado da sala; com React o estado vira a fonte da tela. O CSS global já causou três colisões de nome de classe; componentes (CSS Modules ou Tailwind) evitam isso por construção.
- **O que se aproveita sem reescrever:** toda a lógica pura e testada (`lyrics-sync.js`, `queue-view.js`, `music.js`, `youtube.js`, `identity.js`), `engine.js` e `preview.js` (áudio), o CSS (tokens e telas) e **os 100+ testes de ponta a ponta**, que verificam o comportamento na tela e servem de rede de segurança.
- **Plano de migração (sugerido):** Vite + React + TypeScript; `apps/web` ganha `src/` e build para `dist/`, que a API serve no lugar de `public/`; migrar uma tela por vez (entrada → controle → TV), mantendo o teste de ponta a ponta verde a cada passo; Tailwind opcional.
- **Pré-requisito:** a API não muda (REST + WebSocket já são a fronteira).

## 17. Roteiro após a 1.1.0 (decidido em out/2026)

Ideias escolhidas pelo dono do projeto após uma revisão do que o app tem e do que falta. Nada abaixo foi construído ainda. **Decisão:** o processamento no navegador (separar a voz com WebGPU/ONNX) **não** faz parte do plano; a separação continua no worker do servidor ou no agente do dono. "Separar o áudio sem baixar a música" saiu junto, já que o navegador não consegue ler o stream do YouTube.

### Fase A: fundação
| Item | Observações |
|---|---|
| Ambientes de homologação e staging | Já desenhados no TRD 12.13. Feitos primeiro para que as fases seguintes saiam com segurança |
| Idiomas (i18n) e acessibilidade | Mover todos os textos para um catálogo e traduzir (inglês e espanhol primeiro). Acessibilidade: contraste, foco por teclado, leitor de tela, letra grande na TV. A interface deixa de ser "só em português" como não-objetivo |
| Sala web com abas, como o app desktop | A página da sala ganha as abas **Sala** e **TV** (e o painel do anfitrião), e a TV vira um modo da mesma página. A rota `tv.html` continua, então nada quebra. **O QR code passa a ser o link da sala:** quem entra por ele cai na sala e escolhe ficar na aba **Sala** ou ir para a aba **TV** ver a letra e as músicas que estão passando. Cuidado: o convidado na aba TV é **só espectador** (sem som e sem microfone, para dois aparelhos nunca tocarem a mesma música); só o aparelho que abriu a TV como player (ou a escolha do anfitrião) toca o áudio, e áudio, microfone e tela cheia precisam continuar estáveis ali |

### Fase B: áudio ao vivo (mesmo motor, feitos juntos)
| Item | Observações |
|---|---|
| Compensação de latência | Calibrar com uma batida e o microfone, salvo por dispositivo; afeta pontuação e letra, então vem antes do guia de melodia |
| Volume da voz original | Um slider entre o instrumental e a voz original (o `vocals.mp3` já é guardado); serve de guia para quem está aprendendo a música. Mesa de mixagem do anfitrião |
| Detector de microfonia (apito) | Baseado em FFT; baixa o volume da voz sozinho. Fecha o item "pendente" da 12.14 |
| Mais de um microfone na saída | Várias entradas no Web Audio com limitador; as configurações escolhem mais de um dispositivo (também no app do dono). Fecha o outro item "pendente" da 12.14 |

### Fase C: a festa
| Item | Observações |
|---|---|
| Reações dos celulares | Aplausos, fogo e emojis enviados pelo WebSocket e animados na TV; limite de envio por pessoa |
| Estatísticas do dono | Eventos registrados por sala e música: mais cantadas, tempo de processamento, tamanho do cache; ajuda a limpar o cache |

### Fase D: o canto
| Item | Observações |
|---|---|
| Guia de melodia | Extrair a melodia da voz isolada no processamento (pYIN ou CREPE) e desenhá-la como barras na TV, com a afinação do cantor por cima; reaproveita a base da pontuação. Depende da compensação de latência |
| Dueto com vozes identificadas | Duas camadas. Primeiro **pela letra**: cada linha marcada como voz 1, voz 2 ou ambas (editor, mais uma sugestão por diarização de falantes sobre a voz isolada); o palco mostra quem canta o quê e a pontuação é por trecho. Depois, **pelo áudio**: separação real das duas vozes (pesquisa em aberto, um bônus) |

### Fase E: plataforma
| Item | Observações |
|---|---|
| Modo híbrido (F25) | Por música, escolher se ela também vai para a nuvem (driver S3/R2 já previsto na seção 14). Exige decidir sincronização e custo de armazenamento |
| macOS, Linux e GPU AMD/Apple (F26) | O motor é montado só para Windows. Primeiro macOS em Apple Silicon (MPS), depois Linux (ROCm para AMD) |

### Fase F: a página inicial da web
A página de entrada (`/`) ganha o mesmo visual da tela de boas-vindas do app do dono: a **imagem** (TV, notebook e celular, `apps/desktop/ui/welcome.png`) à **esquerda** e as ações à **direita**.
| Item | Observações |
|---|---|
| Layout | Duas colunas a partir de ~900 px de largura (imagem ~64 %, painel ~36 %, como o `welcome-art`/`welcome-form` do app); no celular a imagem vai em cima (menor) e o painel embaixo. A página mantém o tema escuro, o seletor de idioma e as regras de acessibilidade (axe na suíte) |
| Painel de ações | **Criar sala e abrir a TV** (principal), **Entrar numa sala** (campo do código) e **Baixar o app** (secundário), mais uma frase curta sobre para que serve o app ("para preparar músicas novas no seu computador") |
| Botão de download | O endereço vem do servidor (`APP_DOWNLOAD_URL`, já usado no aviso de atualização), exposto em `/api/config` como `app_download_url` (e a versão mais recente, `app_latest_version`, ao lado do botão). Sem endereço configurado, o botão não aparece. No celular ou num computador que não é Windows, o botão explica que o app é para computadores Windows (macOS e Linux são a fase E) em vez de baixar um arquivo inútil |
| A imagem | Copiada para `apps/web/public/` (o app mantém a própria cópia: a política de segurança dele só aceita arquivos locais). Ela tem o slogan "Karaokê de qualquer vídeo do YouTube" **desenhado dentro**, e as telas dentro dela mostram o menu antigo: a imagem deve ser reexportada **sem o texto** (o título e o slogan viram texto traduzido) e com as telas atuais. Até lá a página usa a imagem atual e corta o texto com CSS se precisar |
| Testes | Os testes ponta a ponta da entrada são atualizados; novos para o layout de duas colunas e o de celular, o botão de download (aparece, some sem endereço, explica no celular) e o axe na página nova; os três idiomas ganham os textos novos |

**Status da fase F (versão 1.1.3):** feita. A `/` agora tem a imagem à esquerda e as ações à direita (no celular, empilhadas: a imagem em cima); o `GET /api/config` devolve `app_download_url` (só links `http(s)`; é o `APP_DOWNLOAD_URL`, hoje o `releases/latest` do repositório) e `app_latest_version`; o bloco do app mostra o link **Baixar o app para Windows (vX.Y.Z)** num computador Windows, uma explicação com um link para a "página de downloads" no celular ou em outro sistema, e nada sem endereço. Foi usada a imagem atual (copiada para `apps/web/public/welcome.png`); reexportá-la sem o slogan em português desenhado dentro e com as telas atuais continua em aberto, e por enquanto só o texto alternativo dela é traduzido.

**Decisões da fase F (respondidas)**
1. **Onde fica hospedado o instalador?** Hoje o `APP_DOWNLOAD_URL` aponta para uma pasta **privada** (veja o `deploy/README.md`). Um botão público precisa de um link que qualquer pessoa abra: as Releases do GitHub deste repositório (o repositório é público) ou o link que você já usa. Sem um link público o botão fica escondido.
2. **A imagem:** reexportar sem o texto e com as telas atuais (recomendado, precisa da arte nova de você) ou usar a imagem atual por enquanto.
3. **Ordem:** a F é independente de A a E. Recomendado: logo depois da fase B (versão 1.1.3), por ser pequena e visível; C, D e E seguem depois.

*Respostas:* (1) o `APP_DOWNLOAD_URL` aponta para o `releases/latest` do repositório; (2) a imagem atual por enquanto; (3) a F vem logo depois da B, como 1.1.3.

**Versões:** a fase A saiu como **1.1.1**, a B como **1.1.2**, a F como **1.1.3**, a C como **1.1.4** e a D como **1.1.5**. A **1.2.0** fecha este roteiro com as fases A, B, C, D e F. **A fase E (plataforma: modo híbrido, macOS, Linux e GPU AMD/Apple) e os ambientes de homologação e staging (seção 18) ficam para a 1.3.0**; o PLAN guarda o desenho deles para lá.

### Ordem e dependências
A antes de tudo (versões seguras e a base de textos e abas) → B (um motor de áudio) → C (retorno rápido) → D (precisa da B) → E (a maior e mais incerta). Cada item vira um marco próprio, com testes, no formato de sempre (seção 16).

### Status da Fase A (versão 1.1.1)
- **Feito:** a página da sala tem a alternância **Sala | TV** (a aba TV é só para assistir: sem som e sem microfone; o QR code é o link da sala) e a interface existe em **português (Brasil), inglês e espanhol** (`apps/web/src/i18n/`: um catálogo por idioma, seletor de idioma na entrada e na sala, o idioma do navegador como padrão; um teste confere que os três catálogos têm as mesmas chaves e que toda chave usada no código existe).
- **Mensagens do servidor:** a API ainda responde em português; o cliente traduz os códigos de erro que os convidados veem (chaves `apierr.*`) e usa o texto do servidor nos demais.
- **Acessibilidade (feita):** verificação automática com axe-core em todas as telas e diálogos (WCAG 2.1 A/AA, na suíte de ponta a ponta); botões de **tamanho da letra** (A−/A+, e `+`/`−` na TV) compartilhados pela TV, pelo palco e pela aba TV; link "ir para o conteúdo"; aviso para leitor de tela de quem está cantando; `aria-current` nas abas; suporte a `prefers-reduced-motion` e `prefers-contrast`; correção de contraste na fila da TV.
- **Adiado:** os ambientes de homologação e staging (seção 18) ficam fora da 1.1.1: dependem das configurações da VM da Oracle, que não puderam ser conferidas (sem acesso à conta). Voltam assim que for possível; os marcos H1 a H3 não precisam da VM.

## 18. Plano: ambientes de homologação (`hml`) e de staging (`stg`)

Desenho por trás do TRD 12.13. Nada abaixo foi construído ainda; as decisões em aberto estão no fim e o plano supõe a resposta recomendada para cada uma.

### Objetivo
Uma versão é testada primeiro em `hml`, depois em `stg`, e só então promovida para produção **por uma pessoa**, com a **mesma imagem** em todos os passos (a tag é o commit; nada é reconstruído).

### Caminho de uma versão (recomendado)
| Evento | Vai para | Como |
|---|---|---|
| Push em `release/**` (CI verde) | `hml` | automático; o dono testa com celulares e TV de verdade **antes** de mesclar |
| Merge na `main` (CI verde) | `stg` | automático; uma cópia da produção com o commit exato que vai sair |
| Botão "Promover" (workflow manual, com aprovação) | produção | `workflow_dispatch` com o ambiente e a tag; os **Environments** do GitHub (`hml`, `stg`, `production`) com um revisor obrigatório dão a etapa de aprovação |

Hoje todo merge na `main` vai direto para a produção; isso muda no último passo (a produção deixa de seguir a `main`).

### Infraestrutura (a mesma VM gratuita)
- **Três pilhas, uma VM:** um projeto Docker Compose por ambiente (`sg-hml`, `sg-stg`, `sg-prod`), cada um com a própria API, Redis, volumes e pasta `storage/`. A VM Ampere gratuita (2 OCPU, 12 GB) comporta as três; a alternativa AMD de 1 GB **não**.
- **Uma entrada (Caddy) numa pilha "edge" separada:** o Caddy escuta em 80/443 e roteia três nomes para os containers `api` numa rede Docker compartilhada (`singalong-net`). Hoje o Caddy mora dentro da pilha de produção, então um deploy de produção o reinicia; tirá-lo de lá também desfaz esse acoplamento. O volume dos certificados (`caddy-data`) é **mantido** (movido, não recriado) para não esbarrar nos limites do Let's Encrypt.
- **DNS:** `singalong-hml.duckdns.org` e `singalong-stg.duckdns.org` apontam para o mesmo IP da produção.
- **Pastas:** `/opt/singalong` continua sendo a produção (sem mudar de lugar); `/opt/singalong-hml`, `/opt/singalong-stg` e `/opt/singalong-edge` são novas.

### Isolamento (o que nunca pode ser compartilhado)
- **Dados:** cada ambiente tem volumes, banco, Redis, `ADMIN_TOKEN` e `ADMIN_PATH` próprios.
- **E-mail:** `hml`/`stg` **não** têm `BREVO_API_KEY` (o servidor já responde `email_disabled`) e têm um `PAIR_ALLOWED_EMAILS` só de teste, para ninguém receber um e-mail de teste por engano.
- **Biblioteca na nuvem:** `ENABLED_TO_SEND_TO_CLOUD` fica vazio em `hml`/`stg`; o `storage/` deles é separado do da produção. O `hml` ganha uma biblioteca pequena de músicas do próprio dono; o `stg` pode receber uma cópia somente leitura da biblioteca da produção (decisão 4).
- **Marcador visível:** uma nova variável `APP_ENV` (`hml` | `stg` | vazia = produção) sai em `/api/config`; as páginas web mostram uma faixa colorida e o prefixo `[HML]`/`[STG]` no título, para ninguém confundir um ambiente com outro.

### Deploy e volta atrás
- `deploy.sh <ambiente> <tag>` substitui o `deploy.sh` atual: usa a pasta do ambiente, define `IMAGE_TAG`, baixa exatamente aquela tag e espera a API ficar saudável.
- O `deploy.yml` deixa de mover o `latest` sozinho: publica `ghcr.io/…/singalong-api:<sha>`, faz o deploy em `hml`/`stg` conforme a tabela acima, e um segundo workflow, **Promover**, publica uma tag escolhida em qualquer ambiente (serve também de **rollback**: promover a tag anterior).
- Manter as últimas 5 tags na VM (o `docker image prune` preserva as recentes).

### O app do dono
O endereço do servidor já é uma configuração do app: para `hml`/`stg` o instalador é apontado para o endereço deles à mão, e as variáveis do aviso de atualização (`APP_LATEST_VERSION`, `APP_MIN_VERSION`, …) são por ambiente, o que permite testar o fluxo de atualização com uma versão "mais nova" falsa antes de publicar a Release.

### Marcos
1. **H1 – Compose parametrizado** (nome do projeto, `IMAGE_TAG`, `singalong-net` compartilhada), produção igual. Teste: a produção continua publicando do mesmo jeito.
2. **H2 – Pilha edge** (Caddy fora da produção) só com o nome da produção; uma parada curta e planejada da produção para movê-lo.
3. **H3 – `APP_ENV` e a faixa** (API, web, testes).
4. **H4 – `deploy.sh <ambiente> <tag>`, `deploy.yml` e o workflow Promover**, com os Environments do GitHub.
5. **H5 – Criar o `hml`** na VM (DNS, `.env`, biblioteca pequena) e publicar nele uma branch `release/**`.
6. **H6 – Criar o `stg`** e fazer a `main` alimentá-lo; a produção deixa de seguir a `main`.
7. **H7 – Documentação** (`deploy/README.md`; o TRD 12.13 vira registro do que foi feito).

### Decisões em aberto (a confirmar)
1. **Qual VM você tem?** `VM.Standard.A1.Flex` com 12 GB (comporta) ou a AMD de 1 GB (não comporta três pilhas; aí `hml` e `stg` teriam de dividir uma pilha menor).
2. **O caminho de uma versão:** `release/**` → `hml`, `main` → `stg`, manual → produção (recomendado), ou `main` → `hml` → manual → `stg` → manual → produção (como no TRD 12.13, com uma aprovação a mais).
3. **Aprovações:** usar os Environments do GitHub com você como revisor obrigatório (recomendado), ou só um workflow manual sem aprovação.
4. **Biblioteca no `stg`:** uma cópia somente leitura das músicas da produção (realista, mas copia arquivos com direitos autorais para um segundo lugar na mesma VM) ou só algumas músicas suas, como no `hml`.
5. **Pilha edge:** aceitar uma parada curta e planejada da produção para tirar o Caddy de dentro dela (recomendado), ou manter o Caddy na produção e deixar `hml`/`stg` entrarem na rede dele.
6. **Nomes:** manter `singalong-hml.duckdns.org` e `singalong-stg.duckdns.org`.
7. **Transição:** manter a produção seguindo a `main` até o H6 ficar pronto (recomendado), para nada mudar antes de o novo caminho estar provado.

### Status da Fase B (versão 1.1.2)
- **Compensação de latência (feita):** a TV tem um botão **Atraso** (tecla `L`) com dois controles e uma medição automática (toca estalos pelas caixas e escuta no microfone). O *atraso do som* faz a letra (e a posição enviada aos celulares) acompanhar o que se **ouve**; o *atraso do microfone* faz a pontuação comparar a nota com a melodia do momento em que foi **cantada** (`posição - atraso do som - atraso do microfone`). Guardado por aparelho (`localStorage`). A parte pura está em `lib/latency.js` (testada com gravações sintéticas); a medição usa `ScriptProcessorNode`, então a precisão é de cerca de um bloco (~10 ms).
- **Detector de microfonia (feito):** um analisador escuta o microfone antes do ganho; o `lib/feedback.js` procura um tom estreito, quase puro, que fica na mesma frequência e **cresce** (ou fica muito forte por 0,8 s), sem harmónicos fortes (uma nota cantada tem). Cada detecção corta o volume da voz pela metade (até 5 %), a TV mostra um aviso, e o volume volta 15 % por segundo depois de 3 s sem apito, sem passar de 80 % do nível em que o apito apareceu (o limite é esquecido depois de um minuto). Testado com espectros sintéticos (tom, nota cantada com harmónicos, sirene, tom forte e fixo, recuperação).
- **Mais de um microfone (feito):** um botão **Microfones** na TV (tecla `M`) lista as entradas do aparelho; até 4 podem ser marcadas, uma por cantor, guardadas naquela TV (`voiceMics`). Cada microfone tem o próprio analisador, a própria guarda de microfonia e o próprio ganho (um apito corta **só aquele microfone**, e o aviso diz qual); eles são somados e passam por um **limitador** (`DynamicsCompressor`, -6 dB, 20:1) para dois cantores nunca estourarem. O primeiro marcado também faz a pontuação (`openMic(deviceId)`); sem nenhum marcado vale o microfone padrão, como antes. Se um microfone não abrir (desconectado), os outros seguem e a TV avisa. No app do dono, o microfone das configurações passa a ser só o padrão: um aparelho que a página escolhe por conta própria não é mais sobrescrito (`room-preload.cjs`). A pontuação continua de **um** cantor (o primeiro microfone): pontuar cada cantor é da fase D.
- **Volume da voz original (feito):** um novo nível por música, `guide` (0 a 100 %), definido como o das vozes de apoio (quem escolheu a música ou o anfitrião; só aparece nas músicas que têm o arquivo). A TV toca o `vocals.mp3` em sincronia com o instrumental, dentro do mesmo grafo da troca de tom, então o guia está no **tom em que se canta**. O arquivo é servido pelo armazenamento do servidor (`media.vocals`) e pelo servidor local de mídia do dono (o catálogo agora leva `files.vocals`); **ele nunca sobe para a nuvem**, então músicas que só existem na nuvem não têm guia. As trilhas extras do motor (apoio e guia) usam uma implementação só (`createStem`). A lista de arquivos do servidor local de mídia agora inclui o `vocals.mp3` (o teste dele foi atualizado: a voz isolada antes era recusada).
- **A Fase B está completa.**

### Status da Fase C (versão 1.1.4)
- **Reações dos celulares (feito):** cinco botões (aplauso, fogo, amei, festa, uau) no cartão "tocando agora" e na aba TV. Um toque manda `{type:'reaction', kind}` pelo WebSocket da sala; o servidor aceita só os cinco tipos, só de celulares, com um **balde de fichas por conexão** (uma rajada de 6, depois 3 por segundo; o resto é descartado em silêncio) e a difunde, com o nome de quem mandou, para a TV, para a aba TV e para o palco do cantor. Os emojis sobem e somem (3,2 s, no máximo 30 ao mesmo tempo, `aria-hidden`; com menos movimento eles só piscam). Toda reação durante uma música também é contada nela (`queue_items.cheers`).
- **Estatísticas do dono (feito):** a fila some com a sala (24 h), então uma tabela durável nova, **`play_log`**, guarda uma linha quando uma música de uma sala de dono termina ou é pulada (título, artista, nome do cantor, uma chave sem volta da pessoa, dueto, nota, aplausos, resultado); nenhum `client_id` é guardado, e linhas com mais de 400 dias são podadas. O `GET /agent/v1/stats?days=` (token do dono) devolve os totais, as mais tocadas, quem mais cantou, as mais aplaudidas e o movimento por dia. O app do dono ganhou um cartão **Estatísticas** na aba Sessão (com seletor de período) que também mostra a **biblioteca local**: número de músicas, espaço em disco, tempo médio de preparo (a soma dos `timings_s` de cada `meta.json`) e as músicas que mais ocupam espaço, o que ajuda a limpar o cache. A verificação do cartão está no teste de janela do app, que só roda no CI (Windows).
- **A decidir:** uma chave do anfitrião para silenciar as reações e uma ação "limpar as músicas maiores" no cartão de estatísticas.

### Status da Fase D (versão 1.1.5)
- **Guia de melodia (feito):** um novo interruptor do anfitrião (ajuste da sala `melody_bars`, desligado por padrão). A TV desenha uma faixa entre a letra e a barra de progresso com as **notas da voz original como barras** que andam para a esquerda (2 s do passado, 6 s do futuro; a linha do "agora" a um quarto da largura), no **tom escolhido**, e a afinação de quem canta por cima: **verde** quando está na nota (sem olhar a oitava, até 1 semitom de erro), **vermelho** quando não, desenhada na oitava mais perto da barra. Ele reaproveita a melodia que o worker já extrai (`melody.json`) e a mesma suavização da pontuação (`lib/melody-guide.js`, testado), e os ajustes de latência (as barras acompanham o que se **ouve**; a trilha cantada, quando foi **cantado**). O microfone é compartilhado com a pontuação: o guia funciona sem pontuar (aí só precisa de um microfone na TV).
- **Dueto com vozes identificadas, pela letra (feito):** o dono da música e o convidado (ou o anfitrião) abrem **Dividir a letra** e marcam cada linha como **voz 1**, **voz 2** ou **juntos**; ela parte da divisão automática. A escolha é guardada por música (`song_settings.parts`, um texto com `a b * -`, uma letra por linha), vale em qualquer sala e só vai no estado das músicas com dueto aceito. A TV e o palco pintam as linhas com ela; se a letra mudar de tamanho, volta a valer a divisão automática.
- **Pontuação do dueto por voz (feito):** com a pontuação ligada, um dueto aceito e **dois ou mais microfones** escolhidos na TV, o primeiro microfone é a voz 1 e o segundo é a voz 2; cada um tem o próprio pontuador, que só conta as linhas daquela voz (as linhas "juntos" contam para os dois). O cartão final mostra a nota de cada cantor ("Ana 82 · Bia 74") e a nota da sala é a **média** (uma música tem uma nota só no servidor). Com um microfone só nada muda: a música inteira é pontuada por ele.
- **Fora de propósito:** a sugestão por IA de quem canta cada linha (diarização de falantes da voz isolada) e a separação real de duas vozes que se sobrepõem; o editor parte da divisão automática. O editor lê a letra do servidor; nas músicas do computador do dono só funciona enquanto a música toca (a TV repassa a letra).

**Fechamento da versão 1.2.0:** as fases A, B, C, D e F estão feitas e publicadas (1.1.1 a 1.1.5). Ficam para a **1.3.0**: a fase E e os ambientes de homologação e staging (seção 18, cujos marcos H1 a H3 não precisam da VM da Oracle e podem abrir o ciclo).

### Correções da 1.2.1
Encontradas usando a 1.2.0 numa TV e num microfone de verdade:
- **A letra se ajusta ao cartão:** uma linha que quebra em três não passa mais por cima da seguinte: as linhas deixaram de encolher e a fonte é reduzida aos poucos (`--fit`) até tudo caber, a cada troca de linha. **A linha que já passou não fica mais à mostra.**
- **Cartão da pontuação na extrema direita**, fora do guia de melodia (o guia ganha uma margem do tamanho do cartão enquanto a pontuação está ligada).
- **Cores no guia de melodia:** no dueto as barras ganham a cor de quem canta aquela nota (turquesa a voz 1, violeta a voz 2, amarelo juntos, apagado fora da letra), como na letra; a nota do momento ganha um contorno claro e a trilha de afinação do segundo cantor também é desenhada.
- **Ruído e eco da voz:** o caminho da voz já usava o cancelamento de eco e a supressão de ruído do navegador (ganho automático desligado, para evitar microfonia). Agora também tem um **filtro de graves (110 Hz)** e um **portão de ruído** por microfone (abre acima de -46 dBFS, espera 280 ms, fecha a 12 %): quando ninguém canta, o ruído da sala e o restinho da música deixam de sair nas caixas. Vem ligado e dá para desligar no diálogo **Microfones** (fica guardado naquela TV). Parte do "eco" que se ouve ao cantar é o atraso inevitável de ouvir a própria voz pelas caixas (microfone + processamento + saída); só diminuir o volume da voz, usar um conjunto com fio ou fone para quem canta tira isso.
- **Topo e barra lateral:** o seletor de idioma não estica mais pelo topo inteiro (valia o `select { width: 100% }` global) e a barra lateral fica abaixo do topo qualquer que seja a altura dele (o topo mede a si mesmo: `--topbar-h`).
- **Volume da voz ao lado do interruptor:** o balão só abre com o mouse em cima (ou o teclado no foco), centrado no interruptor, e agora leva a explicação do interruptor (a dica separada cobria o volume).

### Correções da 1.2.2
- **O cartão da pontuação não flutua mais:** ele era `position: fixed` e cobria o QR code numa janela menor (a do app do dono). A TV agora tem uma **faixa de baixo** (`.tv-lower`) dentro do layout: o guia de melodia e o cartão da pontuação lado a lado; sem o guia, a pontuação é uma tira baixa à direita. Um teste confere que nenhum cartão se sobrepõe a outro em quatro tamanhos de janela (900x600 a 1920x1080).
- **O aviso de pausa da letra começa em 3 s** (eram 8 s; `MIN_GAP_SECONDS`). Os traços ficam cheios no começo da pausa e somem nos últimos 8 s, ou **ao longo da pausa toda quando ela tem menos de 8 s** (uma pausa de 3 s tem 3 s de contagem).
- **Layout das estatísticas do dono:** o seletor de período esticava até 260 px de altura (um `.card .row select { flex: 1 1 260px }` global valia para ele dentro de um rótulo em coluna). O cartão agora tem um cabeçalho com o título e os controles na mesma linha, os números em grade, um gráfico com legenda e as datas das pontas, e as listas em duas colunas.

### Correções e novidades da 1.2.3
- **A coluna da direita da TV cabe na própria linha:** com a fila cheia (a música que toca e mais sete esperando), a fila e o cartão do QR code cresciam além da tela e caíam sobre a faixa de baixo (pontuação e guia de melodia) em janelas menores. A coluna agora é uma coluna flex limitada pela linha dela: a fila encolhe (o que não cabe vai sumindo) e o QR code acompanha a altura da tela. Um teste enche a fila e confere que nenhum cartão se sobrepõe a outro, nem sai da tela, em sete tamanhos de janela (960x560 a 1920x1080).
- **Controle de versão e mensagem de atualização na página do administrador** (tabela `app_release`; o `GET /state` devolve `release` e a versão de cada computador; `PUT`/`DELETE /release`): o que se publica ali substitui `APP_LATEST_VERSION`, `APP_MIN_VERSION`, `APP_NOTES` e `APP_DOWNLOAD_URL` do `.env` **na hora**, para os apps instalados (`/agent/v1/version` e a batida de coração) e para a página inicial (`/api/config`). Valida o formato (`1.2.3`), que a mínima não passe da mais recente, o tamanho da mensagem (500) e que o endereço seja http/https. Cada computador agora informa a versão na batida de coração (`devices.app_version`) e a página mostra quem está em dia, quem tem atualização disponível e quem está abaixo da mínima.
- **Assinatura do .exe, pronta e à espera de um certificado:** o `apps/desktop/scripts/signing.mjs` escolhe a assinatura pelo ambiente (certificado em arquivo por `CSC_LINK`, ou Azure Trusted Signing; nenhum = sem assinatura, como antes; `SINGALONG_REQUIRE_SIGNING=1` falha sem certificado) e o `scripts/verify-signature.mjs` confere o resultado. O build verifica o que gerou. Foi provado de ponta a ponta com um certificado de teste autoassinado: o programa, o instalador, o desinstalador e o `elevate.exe` saíram assinados e com carimbo de hora. No CI, o job `installer` usa o certificado de verdade quando os segredos existem e, sem eles, um certificado de teste descartável. **O que falta é o certificado em si** (veja no README as opções e os limites).

### Correções e novidades da 1.2.4
- **QR code ao lado de quem canta, coluna da direita só para a fila:** na TV o QR code da sala passa para a esquerda de "Cantando agora" (nome, música e tom), e a coluna ao lado da letra fica só para a fila, que usa a altura toda (a música atual e as próximas cinco). O texto "Entre na sala XXXX" continua embaixo do QR code, para deixar claro para que ele serve. Abaixo de 900 px de largura o QR code some, como a coluna sumia. O teste de sobreposição agora também confere que o QR code fica acima da letra, à esquerda de quem canta, e que a fila termina antes da faixa de baixo.

### Correções e novidades da 1.2.5
- **O app mantém o worker atualizado:** o código do worker dentro do motor (`engine/app`, na pasta de dados do usuário) só era copiado quando o motor era montado pela primeira vez. Depois que o app se atualizava sozinho, o computador seguia com o worker antigo: informava uma versão velha ao servidor (que pode recusá-la como "atualização necessária" e parar de lhe enviar trabalho, como a busca no YouTube) e não tinha os recursos novos (como a sincronização com a nuvem). Agora, ao abrir com o motor já montado, o app compara a versão do worker que veio no instalador com a instalada e troca a cópia quando diferem (`refreshWorker` em `apps/engine/src/assemble.js`; o registro mostra "Aplicativo do motor atualizado: 0.4.0 → 1.2.5"). Testes cobrem a cópia (sem sobras da versão antiga, sem mexer quando já está em dia) e o controlador.

### Correções e novidades da 1.2.6
- **Pontuação e guia de melodia marcados como beta:** os dois seguem a voz original por aproximação e ainda não são totalmente fiéis, então o app agora diz isso. Uma etiqueta "beta" aparece nos dois interruptores do painel do anfitrião (com a explicação na dica e no nome acessível, ex.: "Pontuação pelo microfone (beta)"), na TV (guia de melodia, quadro de pontuação e nota final), no placar da sala e na nota do próprio cantor na tela do palco; a dica da etiqueta explica o motivo. O README (nos dois idiomas) traz o mesmo aviso. Nada mudou em como a pontuação funciona.

## 19. Plano da 1.3.0: o app para macOS e Linux (F26)

A **1.3.0 inclui só a F26**. O modo híbrido na nuvem (F25) e os ambientes `hml`/`stg` (seção 18) ficam para depois.

**Decisões (respondidas)**
1. **Sistemas:** **Linux x64** (AppImage) e **macOS Apple Silicon** (DMG). **Mac Intel fora**: o PyTorch 2.5.1 não tem versão para ele.
2. **macOS sem assinatura Apple por enquanto:** o usuário abre com clique direito → Abrir na primeira vez e atualiza baixando a versão nova (sem atualização automática no Mac; o Linux atualiza sozinho). A home e o README explicam. Assinar e notarizar (Apple Developer, ~US$ 99/ano) fica como evolução.
3. **GPU AMD (ROCm) e Apple (MPS) só depois de medir o ganho:** primeiro tudo em CPU (e NVIDIA no Linux). Parte dos modelos do separador roda pelo `onnxruntime` (hoje cai para a CPU até no Windows), então o ganho real é desconhecido.
4. **Links por sistema:** `APP_DOWNLOAD_URL` continua único (a base `…/releases/latest/download/` do GitHub) e o servidor acrescenta o **nome fixo** do arquivo de cada sistema: `singalong_karaoke.exe`, `singalong_karaoke-mac-arm64.dmg`, `singalong_karaoke-linux-x86_64.AppImage`. Uma versão só para os três sistemas.

**O que muda**
| Parte | Hoje | Na F26 |
|---|---|---|
| Manifesto do motor | uma plataforma (`win32-x64`) | `platforms` com um bloco por sistema (`win32-x64`, `linux-x64`, `darwin-arm64`): Python (python-build-standalone), ffmpeg e deno de cada um, com URL e SHA-256 |
| Caminhos e extração | `python.exe`, `bin/*.exe` | `python/bin/python3`, binários sem `.exe`; `tar` como padrão fora do Windows (já previsto) |
| Hardware (`hardware.py`) | NVIDIA → `cu121` ou CPU | Linux: NVIDIA (`cu121`) ou CPU; macOS: CPU (MPS e ROCm só no marco final) |
| Navegador dos cookies | só Windows | macOS e Linux: detectar o navegador padrão (Chrome, Edge, Firefox, Safari quando aplicável) |
| Empacotamento | NSIS | AppImage (Linux) e DMG (macOS), com `artifactName` fixos; `latest.yml`, `latest-linux.yml` e `latest-mac.yml` |
| CI | motor em ubuntu e windows; instalador no windows | motor também em macOS (arm64); jobs que geram AppImage e DMG |
| Home (`/`) | um botão para Windows | o sistema detectado do visitante vira o botão principal ("Baixar para macOS (Apple Silicon) – vX"); lista "Outros sistemas" sempre visível; no macOS pergunta "Qual é o seu Mac?" (o navegador não distingue Intel de Apple Silicon) e avisa que Intel não é suportado; o celular continua explicando que o app é para computador |
| `/api/config` | `app_download_url`, `app_latest_version` | acrescenta `app_downloads` (lista de `{system, url, label}` montada a partir da base) |

**Marcos**
1. **M1 – Motor no Linux x64** (CPU e NVIDIA): manifesto por plataforma, caminhos, hardware, testes no CI (ubuntu).
2. **M2 – Motor no macOS Apple Silicon** (CPU): componentes do Mac, navegador padrão, testes no CI (macOS arm64).
3. **M3 – Empacotamento e release:** AppImage e DMG no CI; release com vários arquivos; atualização do Linux; aviso de atualização manual no Mac.
4. **M4 – A home:** detecção do sistema, lista de outros sistemas, escolha do Mac, `app_downloads`; textos nos três idiomas; testes e axe.
5. **M5 – GPU AMD e Apple:** medir o ganho do ROCm e do MPS na separação e na pontuação; só entra se compensar.

**Limites e riscos**
- **Sem Mac nem Linux de verdade aqui:** o CI testa a montagem e o código, mas não tem GPU nem microfone; o teste em máquinas reais fica com o dono.
- **Cookies do YouTube:** a leitura dos cookies do navegador muda por sistema (Keychain no Mac, keyring no Linux); pode exigir o arquivo `youtube_cookies.txt` como alternativa.
- **`torch` por plataforma:** o Linux usa o índice `cpu` ou `cu121`; o macOS usa o pacote padrão do PyPI (que já traz o MPS).

**Status do M1 (motor no Linux x64): feito.**
- **Manifesto por sistema:** o `manifest.json` agora tem `platforms` (`win32-x64` e `linux-x64`) e `resolveManifest`/`loadManifest` escolhem os componentes do sistema (Python da python-build-standalone, ffmpeg GPL da BtbN e deno, todos com URL oficial e SHA-256). O **hash do manifesto do Windows não mudou** (`28529b9dc9631f40`, com um teste): quem já montou o motor no Windows não precisa refazê-lo. Um sistema sem motor recebe uma mensagem clara.
- **Defeitos que só apareceram no Linux de verdade (corrigidos):** o Python do Linux tem `bin/python3 -> python3.11` e a cópia guardava o caminho da pasta temporária (o link quebrava quando ela era apagada); agora os links ficam relativos (`verbatimSymlinks`). Num Linux enxuto faltam `xz` e `unzip` (o ffmpeg do Linux vem em `.tar.xz` e o deno em `.zip`): o Python do próprio motor abre os dois como reserva. Os programas de `bin/` recebem permissão de executar. O `PATH` do worker inclui `python/bin`.
- **Navegador padrão do Linux:** `detectDefaultBrowser` consulta o `xdg-settings` (Chrome/Chromium/Brave = `chrome`, Edge = `edge`, outro = automático); o worker acha também o Chrome em `/opt/google/chrome` e o Edge em `/opt/microsoft/msedge`.
- **Prova com tudo de verdade:** o motor foi montado do zero num container Debian enxuto (sem `xz` nem `unzip`) com downloads reais, torch de CPU e todos os pacotes, e a verificação passou (ffmpeg com `libx264`/`aac`/`libmp3lame` e os filtros `rubberband`/`subtitles`, deno, Python 3.11.17 e torch 2.5.1+cpu, e o worker inicia). O CI ganhou o job **Motor real no Linux**, que repete isso a cada mudança.
- **Ainda sem prova:** o torch `cu121` (NVIDIA) no Linux usa o mesmo caminho do Windows (índice oficial do PyTorch) mas não foi testado numa placa de verdade.

**Status do M2 (motor no macOS Apple Silicon): feito.**
- **Manifesto `darwin-arm64`:** Python (python-build-standalone, aarch64), deno e **ffmpeg 9.0.2 GPL do martin-riedl.de** (a BtbN não faz builds para Mac), com `ffmpeg` e `ffprobe` como arquivos separados. Todos têm SHA-256 fixado e os binários vêm assinados (obrigatório no Apple Silicon).
- **O ffmpeg do Mac não tem o `rubberband`** (nem esse nem o do osxexperts). Só o vídeo MP4 exportado usa a troca de tom do ffmpeg, então o worker passou a **detectar o filtro** (`has_rubberband`) e, sem ele, trocar o tom por `aresample`+`asetrate`+`atempo` (muda a taxa de amostragem e devolve a duração; testado: a duração se mantém de -12 a +12 semitons). Fica um pouco menos natural que o rubberband, mas serve ao vídeo do karaokê. A verificação do motor no Mac exige só o filtro `subtitles` e avisa "sem rubberband".
- **Hardware:** no macOS a razão da escolha é "o motor roda na CPU por enquanto (a GPU da Apple fica para uma versão futura)".
- **Navegador padrão no Mac:** o app lê os handlers do LaunchServices (`plutil`): Chrome/Brave/Vivaldi = `chrome`, Edge = `edge`, Safari ou sem escolha = automático.
- **Prova com tudo de verdade:** o CI monta o motor do zero num macOS Apple Silicon (downloads reais, torch 2.5.1 e todos os pacotes) e a verificação passa (ffmpeg com `libx264`/`aac`/`libmp3lame` e `subtitles`, deno `aarch64-apple-darwin`, Python 3.11.17, torch 2.5.1 e o worker inicia). Os testes do motor e do app também rodam no macOS.
- **Limites conhecidos:** a URL do ffmpeg do Mac é uma versão fixa do martin-riedl.de (se um dia ela sair do ar, troque `url` e `sha256`); o Mac Intel continua sem motor (a mensagem diz que o sistema não é suportado); o app ainda não foi aberto num Mac de verdade (só o motor e os testes do controlador).

**Status do M3 (empacotamento e release): feito.**
- **Três instaladores de nome fixo** (`apps/desktop/src/installers.js`, conferido por teste contra o `package.json`): `singalong_karaoke.exe`, `singalong_karaoke-mac-arm64.dmg` e `singalong_karaoke-linux-x86_64.AppImage`. O `build-installer.mjs` gera o do sistema em que está (`--platform=win|mac|linux`; o DMG só num Mac) e **confere o resultado**: nome, tamanho, ELF executável e `latest-linux.yml` no Linux, a assinatura ad-hoc válida (`codesign --verify`) no Mac e a assinatura do Windows como antes.
- **macOS:** assinatura ad-hoc explícita (`identity: "-"`, `hardenedRuntime: false`; o electron-builder não faz ad-hoc sozinho e o Apple Silicon encerra programa sem assinatura). Sem assinatura da Apple o macOS recusa trocar o app por si só, então no Mac o "Atualizar agora" **abre o download do DMG novo** (`installerUrl`); o app mostra o menu do sistema (é ele que dá o Cmd+C/V) e reabre pelo Dock (`activate`).
- **Linux:** o AppImage se atualiza sozinho pelo `latest-linux.yml`. Em distribuições que restringem os namespaces de usuário (Ubuntu 24.04+) o AppImage não abre com o sandbox do Chrome; só nesse caso o app liga `--no-sandbox` (`needsNoSandbox`, testado), nos outros o sandbox continua.
- **Janela:** `showWindow()` abre de novo a janela que foi fechada de verdade (antes a bandeja e a segunda instância chamavam `show()` numa janela destruída).
- **Ícone** de 1024 px (o macOS e o AppImage exigem pelo menos 512): o `make-icon.cjs` agora também gera `build/icon.png` grande (e corrigi o script: sem tratar `window-all-closed` o Electron encerrava ao fechar a primeira janela).
- **CI:** o job **Instalador do Linux / do macOS** gera e confere cada um a cada mudança. O workflow manual **Instaladores de Linux e macOS** (`release-installers.yml`) gera os dois e os anexa à release da tag informada (rascunho se não existir); o do Windows continua sendo gerado e anexado pelo dono.
- **Prova:** o AppImage foi gerado de verdade (120 MB) e **aberto** num Linux virtual (Debian com tela falsa): a janela "Singalong Karaoke" abriu e carregou a interface. O DMG é gerado no macOS Apple Silicon do CI e a assinatura ad-hoc passa no `codesign --verify` (o app do Mac se chama `singalong_karaoke.app`; o electron-builder pula a assinatura em builds de pull request, então o script força `CSC_FOR_PULL_REQUEST` só para a ad-hoc, que não usa segredo).
- **Ainda sem prova:** abrir o app numa janela de verdade num Mac (o CI só gera e confere o DMG) e o fluxo de atualização do AppImage.

**Status do M4 (a página inicial): feito.**
- **Servidor:** `apps/api/src/installers.js` monta o link de cada sistema a partir da base única (`downloadsFor`) e o `GET /api/config` ganha `app_downloads` (windows, macos, linux) e `app_page_url` (a página com todas as versões, já que a pasta `…/releases/latest/download/` do GitHub não abre no navegador). Quem cola a página da release (`…/releases/latest`) em vez da pasta tem o engano corrigido (`downloadBase`). Um teste confere que os nomes são os mesmos do app e do electron-builder.
- **Página inicial:** o sistema do visitante (`detectSystem`: Windows, macOS, Linux, celular/tablet/Chromebook = sem instalador) vira o botão principal ("Baixar para Linux (v1.3.0)"), com a dica do AppImage (`chmod +x`); os outros sistemas ficam **sempre à vista** numa lista; "Ver todas as versões" leva à página da release. No **Mac** o navegador sempre se diz Intel, então a página pergunta "Qual é o seu Mac?": só quem responde Apple Silicon recebe o DMG (com o aviso de clique direito > Abrir) e quem responde Intel recebe a explicação de que o app não funciona nele. Celular e outros sistemas recebem a explicação e a lista (para levar o link a um computador). Textos em português, inglês e espanhol; o axe passa em todos os caminhos (Windows, Mac antes e depois da resposta, celular).
- **Painel do admin:** o campo do endereço agora diz que é a pasta dos instaladores e que o nome de cada arquivo é acrescentado.

**Status do M5 (GPU AMD e Apple): AMD feita (sem medir); Apple medida e desligada.**
- **Combinado:** o M5 entra na 1.3.0 e a regra do plano continua: só entra se compensar. O CI não tem placa AMD, mas o executor macOS **tem Metal**, então a GPU da Apple pôde ser **medida de verdade**.
- **Apple (Metal), medido:** o motor `mps` montou e passou no autoteste (convolução e FFT complexa), mas ao separar 30 s de áudio o **Demucs falha** no Metal: `NotImplementedError: Output channels > 65536 not supported at the MPS device` (o `PYTORCH_ENABLE_MPS_FALLBACK=1` não cobre esse erro nessa versão do torch). Na CPU a mesma separação funcionou (21 a 43 s para 30 s de áudio no executor). Sem ganho, **a opção não é oferecida** e o Mac usa a CPU, com o motivo escrito ("o Demucs do torch 2.5.1 falha no Metal"). Não dá para subir o torch (o Demucs 4.0.1 quebra com outro). `SINGALONG_APPLE_GPU=1` religa a opção para quem quiser medir de novo, e o job do CI repete a medição a cada mudança (o resumo do job mostra os tempos), então uma versão futura do torch aparece ali. O caminho já está pronto e testado para esse dia: o alinhamento da letra fica na CPU, uma separação que falhar no Metal é refeita na CPU (`devices.py`) e `PYTORCH_ENABLE_MPS_FALLBACK=1` é ligado no Mac.
- **AMD (ROCm 6.2, só Linux):** o worker lê o `/sys` (sem ferramentas) e acha a placa e a arquitetura (`gfx1100`...). Só é escolhida sozinha se o torch 2.5.1/rocm6.2 tem kernels para ela (`gfx900-942`, `gfx1030`, `gfx1100-1102`), tem 3 GB e o usuário acessa o `/dev/kfd`; senão fica na CPU **com o motivo** (ex.: "sem acesso à placa AMD: coloque o seu usuário nos grupos render e video"). A NVIDIA ganha quando há as duas. O torch vem do índice `rocm6.2` (~4 GB; confirmado que os três pacotes existem) e o teste real confere o build do ROCm (`torch.version.hip`) e uma convolução. **Sem placa AMD no CI não foi medida**: lição do Metal, um autoteste pequeno que passa não prova que o Demucs inteiro funciona; a volta para a CPU cobre a falha do teste, mas não uma falha no meio da separação (isso só uma placa de verdade mostra).
- **Como o worker sabe:** o app põe `SINGALONG_ENGINE` (lido do `engine.json`) no ambiente do worker; `devices.py` decide o dispositivo de cada etapa. Quem roda o worker à mão ou no Docker não é afetado.
- **Tela de configurações:** as opções agora são geradas por `ui/gpu.js` (com testes): NVIDIA, AMD (quando serve), o automático e a CPU sempre; a Apple só aparece com a opção ligada.
- **CI:** no macOS o job de motor real pede `--engine mps` (o motor fica `mps` porque o executor tem Metal) e roda o Demucs na CPU e no Metal com 30 s de áudio, mostrando os tempos no resumo do job.

### Correções e novidades da 1.3.1
- **Downloads da página inicial, de novo:** todos os sistemas agora são **botões do mesmo estilo** (o do visitante primeiro, os outros abaixo; antes só o do sistema dele era botão e os outros eram links numa lista). **A versão deixou de aparecer** nos botões. A pergunta "Qual é o seu Mac?" saiu: o botão do macOS (Apple Silicon) vem direto e ganhou **uma dica ao lado** (um "i") com o texto "O app não funciona em Macs com processador Intel. Para cantar, não precisa dele: basta criar ou entrar numa sala." A dica abre com o mouse, com o foco do teclado e com um toque (no celular não existe "mouse em cima"), fecha com Esc, é lida por leitores de tela junto com o botão (`aria-describedby`) e passa no axe aberta. Quem usa Windows ou Linux também a vê ao lado do botão do macOS. No celular, sem sistema detectado, os três botões aparecem sem o título "Outros sistemas".

## 20. Plano da 1.4.0: letra e vozes pela IA (F27)

**O problema.** Hoje a letra vem da legenda do vídeo, da LRCLIB (online) ou de um texto colado; o Whisper só **alinha** um texto que já existe. Num **cover** ou numa música obscura nada acha a letra e a música para com "Não achei essa letra". A 1.4.0 faz a IA **ouvir** a voz isolada (que o Demucs já separa) e escrever a letra com o tempo de cada palavra, e descobrir **quem canta cada linha** num dueto.

**Decisões (respondidas)**
1. **Whisper: uma busca inteligente que mescla o local e a API da OpenAI.** O Whisper do próprio motor roda primeiro (sem custo, offline, a voz fica no computador) e a API só entra **nos trechos em que o local tem dúvida**, se o dono ligou essa opção (com a chave dele e um aviso claro de que trechos da voz isolada vão para a OpenAI). Detalhes abaixo.
2. **Vozes (diarização): embeddings de voz ECAPA do speechbrain, por linha da letra**, sem conta nem token (o `pyannote` pediria token do Hugging Face e aceite de termos). O resultado preenche a divisão do dueto que já existe (`a b * -`) e a pessoa corrige.
3. **Quando a IA gera a letra: um botão marcado como beta.** Onde hoje aparece "Não achei essa letra" passa a haver "**Gerar a letra ouvindo a música (beta)**". Nada roda sozinho; o resultado entra como rascunho que dá para corrigir e realinhar.

**A busca inteligente (como o local e a API se mesclam)**
- **Camada 1 – o catálogo:** a legenda do vídeo e a LRCLIB, como hoje. Texto de catálogo é o mais confiável.
- **Camada 2 – o Whisper local como sonda e como reserva:** transcreve a voz isolada (com a língua detectada pelo áudio) e mede a **confiança** de cada trecho (probabilidade média das palavras, probabilidade de "sem fala", razão de compressão, repetição). Serve para duas coisas: (a) **escolher entre candidatos do catálogo**: o rascunho do áudio é comparado com os textos da LRCLIB, inclusive os achados por um título "limpo" (sem "cover", "feat.", "ao vivo"); se algum bate (similaridade alta), usa-se **o texto do catálogo com o alinhamento forçado**, que sai mais certo que qualquer transcrição; (b) **sem candidato que bata**, o próprio rascunho vira a letra.
- **Camada 3 – a API só onde o local duvida:** os trechos de baixa confiança (e só eles) são recortados da voz isolada e enviados à API (`whisper-1`, com tempo por palavra); o resultado **substitui só aqueles trechos**, com o tempo deslocado para a posição certa. Há um **teto por música** (por padrão 60 s de áudio enviado, estimativa do custo mostrada, cerca de US$ 0,006 por minuto) e a chave fica **só no computador do dono** (nunca no servidor). Sem chave ou sem o consentimento, as camadas 1 e 2 funcionam sozinhas.
- **Filtros contra alucinação** (o ponto fraco do Whisper no canto): descartar trechos repetidos em laço, "[Música]", legendas inventadas em silêncio (uma detecção de voz na faixa isolada antes de transcrever) e linhas com tempo impossível.

**Vozes em dueto (diarização)**
- Para cada linha da letra (já com o tempo das palavras), recorta-se a **voz isolada** daquele trecho, calcula-se o embedding ECAPA (modelo público de ~85 MB, baixado na primeira vez) e agrupa-se em 2 vozes por distância de cosseno (sem scikit-learn: um k-means simples em numpy). Linhas em que as duas distâncias são parecidas viram `*` (as duas cantam). O botão "**Detectar vozes (beta)**" fica nas configurações do dueto e escreve o `parts` (`a b * -`); a pessoa ajusta.
- Limite honesto: o canto sobreposto (duas vozes ao mesmo tempo) e vozes parecidas são difíceis. Linhas curtas (< ~1 s) dão embedding ruim e herdam a voz vizinha.

**Marcos**
1. **T1 – Medir antes de prometer.** Um script (`bench_transcribe`) roda na **biblioteca do dono** e usa as músicas que **já têm letra sincronizada na LRCLIB como gabarito**: mede o erro de palavras (WER) e o erro de tempo de cada modelo (base, small, medium, large-v3-turbo) e o tempo em CPU/GPU, inclusive nos covers. Sem esse número não se escolhe o modelo padrão nem o limiar da camada 3. Não vai áudio protegido para o repositório.
2. **T2 – A fonte `transcribe` no worker:** transcrição com `stable-ts`, confiança por trecho, filtros, escolha do modelo pelo hardware (GPU: o melhor medido; CPU: o menor que presta), sondagem do catálogo e alinhamento forçado do texto escolhido.
3. **T3 – O botão e a revisão:** "Gerar a letra ouvindo a música (beta)" onde hoje se falha, a etiqueta "beta" e a **tela para corrigir o texto** (ao salvar, realinha pelo caminho que já existe).
4. **T4 – A API como complemento:** a chave nas configurações do app (consentimento, teto por música, custo estimado), o envio só dos trechos duvidosos e a mescla.
5. **T5 – Vozes:** embeddings ECAPA, agrupamento, o botão "Detectar vozes (beta)" e o `parts` pronto.

**Limites e riscos**
- **Canto não é fala:** o Whisper foi treinado em fala; erra mais em música alta, vibrato e versos longos. Por isso a letra gerada é **rascunho em beta** e o catálogo vence quando bate.
- **Tempo e disco:** o modelo bom é maior (`medium` ~1,5 GB, `large-v3-turbo` ~1,6 GB) e, na CPU, transcrever demora; o modelo padrão sai das medições do T1.
- **Privacidade:** nada muda sem a API ligada. Com ela, **só trechos duvidosos** da voz isolada saem do computador, com o consentimento do dono.
- **Sem GPU AMD/Apple:** o Whisper roda na CPU nesses computadores (como o resto do motor).

**Status do T1 (medir antes de prometer): feito.** O script `bench_transcribe` (com testes) foi rodado na biblioteca do dono: **8 músicas** com letra da LRCLIB como gabarito (um trecho de 90 s de cada), numa **RTX 3060**, e na CPU (um i9-12900KS de 16 núcleos, 3 músicas de 60 s). Nenhuma música foi marcada como cover, então **o grupo dos covers ainda não foi medido** (o `--covers` o separa).

| Modelo | WER (palavras juntas) | WER mediano por música | Início de linha (mediano) | Velocidade na GPU | Velocidade na CPU* |
|---|---|---|---|---|---|
| `base` | 51% | 45% | 0,39 s | 0,05x o tempo da música | 0,13x |
| `small` | 36% | 32% | 0,33 s | 0,05x | 0,13x |
| `medium` | **25%** | **13%** | 0,42 s | 0,12x | – |
| `turbo` (large-v3-turbo) | **27%** | **15%** | 0,64 s | **0,075x** | 0,27x |

*CPU forte (16 núcleos): uma música de 4 minutos leva ~1 min com o `turbo` e ~30 s com o `small`; num computador mais fraco será mais lento (ainda não medido).

**O que os números dizem**
1. **Modelo padrão: `turbo`.** Empata em qualidade com o `medium` (13% a 15% de erro mediano) e é bem mais rápido; `small` e `base` ficam muito atrás (32% e 45%). Na GPU uma música de 4 min leva ~18 s. Na CPU o `turbo` ainda serve em computadores fortes; em CPUs fracas o `small` é o limite do aceitável. (T2 escolhe por hardware.)
2. **O pior caso é voz processada.** Daft Punk (Stronger), com a voz em vocoder, erra 77% a 98% com qualquer modelo e puxa o WER das palavras juntas para 25%; as outras 7 músicas ficam entre 8% e 16% com o `medium` e entre 6% e 27% com o `turbo`. A letra gerada é **rascunho**, como o plano diz.
3. **O tempo do Whisper é só razoável:** o início de linha erra ~0,4 a 0,7 s (mediano) e só ~60% das linhas ficam a menos de 1 s (a LRCLIB também tem seu ruído). Por isso, **quando o catálogo tem a letra, vale o texto dele com o alinhamento forçado**, e não a transcrição.
4. **A camada 2 (escolher a letra do catálogo pelo áudio) funciona.** O trecho ouvido cabe na letra certa (par certo >= 0,40 no `medium` e >= 0,31 no `turbo`) e quase não cabe nas outras (pares errados <= 0,08): há uma folga grande, com limiar em ~0,24 (`medium`) e ~0,2 (`turbo`); no `small` a folga é menor (0,18 contra 0,09). A mesma música em duas versões não conta como par errado. A amostra é pequena e quase sem covers: o limiar final sai do teste com covers de verdade.
5. **A camada 3 (API só onde o local duvida):** os dois sinais de "dúvida" que o Whisper dá (`avg_logprob` do trecho e `mean_word_prob`, a probabilidade média das palavras) rendem parecido e **nenhum é claramente melhor** (varia de uma rodada para outra). Com o `turbo`, marcar os trechos com `mean_word_prob <= ~0,67` (ou `avg_logprob <= ~-0,43`) pega 57% a 62% dos trechos ruins (65% a 70% do que marca é ruim mesmo) e mandaria **só ~8% das palavras** à API (18% na CPU, amostra pequena). O sinal é útil, não perfeito (as medições variam 1 a 2 pontos entre rodadas, e uma amostra de 8 músicas é pequena); **o ganho real da API (quanto ela corrige) não foi medido, precisa da chave**: fica para o T4.
6. **Ainda sem medir:** os covers, a API e as vozes do dueto (T5).

**Decisão sobre o modelo: a precisão vem primeiro, então o padrão é o `medium`** (o mais preciso que se mediu: 13% de erro mediano), e o `turbo` fica como opção mais rápida (quase igual na qualidade, ~1,6x mais rápido). O T2 escolhe por hardware: GPU ou CPU forte, `medium`; CPU fraca, o `small`.

**Status do T1b (o voto entre transcrições): o mecanismo está pronto, mas votar entre modelos locais não ajuda.**
- **O mecanismo:** `consensus.vote` (e `textmatch.py`, que ele e o resto compartilham, com testes) faz o que a decisão 1 descreve: alinha as transcrições palavra a palavra, em cada divergência vence a palavra que a **maioria** confirma (cada voto pesa `peso x (0,5 + confiança)`), o **tempo** da palavra é o **mediano** dos tempos de quem a confirmou, e o texto vem da fonte de maior prioridade. Uma fonte pode ter peso maior (a letra do catálogo), uma palavra que só uma fonte "ouviu" não entra (alucinação) e uma fonte sem palavras (API que falhou) é ignorada. **Com duas fontes não existe mediano, só empate** (decide a confiança e depois a prioridade): o mediano pede três opiniões.
- **A medição** (`bench_transcribe --vote`, na biblioteca do dono, GPU, 8 músicas): o voto entre **modelos do Whisper** (`medium`, `turbo`, `small`) **não melhora**: `medium` sozinho 12,9% de erro (sem o caso extremo do vocoder), `medium+turbo` 12,5% (dentro do ruído) e `medium+turbo+small` 13,8% (**pior**: o `small` erra junto e arrasta a maioria). Escolher o melhor dos três por música, que é um teto impossível na prática, só chegaria a 23,3% contra 24,7% do `medium` sozinho. **Os modelos do Whisper erram nos mesmos lugares** (mesmo treino): votar entre eles quase não tem o que corrigir. Então o voto entre modelos locais **não vai para o produto**.
- **Onde o voto deve render:** com fontes **independentes**. (a) **A letra do catálogo**, que já é o árbitro mais forte (peso alto). (b) **A API**, com outro modelo e outra decodificação: o `whisper-1` (com tempo por palavra) e, como terceira opinião de uma família diferente, o `gpt-4o-transcribe` (sem tempo por palavra: o tempo vem do `whisper-1` e do local). Isso só se mede com a chave da API, então vira a medição do **T4**: o `medium` local + `whisper-1` + `gpt-4o-transcribe`, em tempo e custo (~US$ 0,05 por música de 4 min com as duas chamadas), contra o `medium` sozinho.
