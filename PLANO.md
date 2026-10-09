# Singalong — Plano de Desenvolvimento

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
| 6 — Front-end em React | ✅ | Vite + React + TypeScript; entrada, TV e sala migradas, com 39 testes de ponta a ponta. Ver decisões abaixo. |

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
- **Jukebox ao adicionar:** ao buscar um vídeo, antes de ir ao YouTube o painel confere se o artista e o nome digitados batem com músicas **já prontas** (`findJukeboxMatches`: todas as palavras, inteiras, sem acento nem pontuação, no artista ou no título; sem artista ou sem nome não sugere nada). Se houver, abre um `<dialog>` ("Encontramos esta versão pronta no nosso Jukebox, quer selecioná-la?" ou, com várias, "...estas versões... quer selecionar uma destas?") com as opções e dois botões: usar a escolhida (entra na fila na hora, como na aba Músicas) ou "Buscar outra versão no YouTube" (segue a busca e não pergunta de novo para o mesmo artista e nome). Esc ou clique fora fecham sem fazer nada.
- **Biblioteca no celular:** o item tem a música e o "Adicionar" na primeira linha e, abaixo, uma faixa "Vídeo MP4 para cantar offline" com o tom e o botão de baixar num controle só.
- **Fora desta fase:** Tailwind e CSS por componente (o CSS global continua; o teste `css.test.mjs` impede nomes de classe repetidos), roteador e React StrictMode.

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
