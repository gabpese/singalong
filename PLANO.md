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

**Fase 4 — Robustez.** Retentativas e erros visíveis (vídeo privado, sem áudio, letra não encontrada), limpeza LRU, Docker Compose, logs.

**Fase 5 — Extras (fora da v1).** Letra palavra a palavra, alinhamento forçado por IA, pontuação por pitch do microfone, export MP4, vídeo de fundo.

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
- **Fase 6 (nova, opcional): Kubernetes** — manifests com kustomize, adaptador Redis do Socket.io, driver S3 ativado, KEDA para o worker.
