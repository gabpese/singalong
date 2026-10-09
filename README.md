# singalong
A project viewing help you sing your favorite songs, being them a cover or no.

Plano completo e decisões: [PLANO.md](PLANO.md).

## Como rodar

Pré-requisitos: Docker (com NVIDIA Container Toolkit para GPU) e `secrets/youtube_cookies.txt` com os cookies
do YouTube (o YouTube bloqueia downloads sem login; a pasta `secrets/` está no `.gitignore`).

```powershell
docker compose --profile gpu up -d --build     # API + Redis + worker com GPU
# sem GPU:  docker compose --profile cpu up -d --build
```

Abra **http://localhost:3000** (para usar outra porta: `$env:API_PORT=3001` antes do comando).
No painel **Adicionar música**, digite o nome da música (pesquisa no YouTube) ou cole um link, e escolha a letra:

| Opção na tela | O que faz |
|---|---|
| Usar a legenda do vídeo, se ele tiver | usa a legenda **manual** do YouTube (auto-legendas são ignoradas de propósito) |
| Buscar a letra na internet | procura a letra no [LRCLIB](https://lrclib.net) por artista + nome da música. Se existe uma versão **com tempos e de mesma duração**, usa; senão (comum em covers) pega o **texto** e a IA o sincroniza com a voz |
| Colar a letra e sincronizar com a voz (IA) | **a saída para covers e vídeos sem referência de tempo**: você cola a letra (uma linha por verso) e a IA (Whisper, em modo "alinhar texto") descobre quando cada linha é cantada, ouvindo a voz isolada. Não gera letra |
| Cantar sem letra | só o instrumental: **sempre** funciona, mesmo quando nada acima serve |
| Avançado: letra que já tem tempos | conteúdo de um arquivo `.lrc` ou `.srt` |

- Sem letra utilizável, o job termina em `needs_lyrics`: o painel explica o motivo e pede outra opção; o instrumental
  já processado é reaproveitado (só a letra é refeita).
- Em covers, informe **Artista** e **Nome da música** para a busca online. A letra de uma versão de duração diferente
  não serve de tempo, então a IA a sincroniza com a voz do vídeo (cerca de 1 minuto na primeira vez; o "Ajuste da letra"
  corrige um atraso constante, se sobrar).
- **Por que não buscamos no Google?** O Google bloqueia acesso automatizado (captcha "unusual traffic"), então a letra é
  buscada no LRCLIB, que tem o texto das músicas testadas. O texto é só o ponto de partida: quem marca os tempos é a IA.
- A legenda do vídeo depende do YouTube liberar o download dela; quando ele limita (HTTP 429), o job segue sem ela.

No player: `Espaço` toca/pausa, `↑`/`↓` muda o tom (±6 semitons), `F` tela cheia. O "Ajuste da letra" corrige o
atraso da letra por música (salvo no navegador).

Tudo fica em `storage/cache/<video_id>/` (`instrumental.mp3`, `lyrics.json`, `meta.json`, `source.json`).

### API

| Rota | Função |
|---|---|
| `POST /api/songs` `{url, lyrics?: {source, text?}, artist?, title?}` | cache pronto → `200 ready`; inédita → `202` e cria o job; já em andamento → `200 deduped` |
| `GET /api/search?q=` | pesquisa vídeos no YouTube (atendida pelo worker; cache de 10 min) |
| `GET /api/songs` | músicas prontas |
| `GET /api/songs/:id` | `status`: `pending`, `processing` (+`stage`), `needs_lyrics`, `ready`, `failed` |
| `PUT /api/songs/:id/lyrics` `{source, text?, loose?, artist?, title?}` | escolhe/troca a letra; `source`: `auto`, `lrclib`, `text`, `file`, `none` (`409` se ainda processando) |
| `GET /media/cache/<id>/...` | arquivos, com `Range` |
| `GET /healthz`, `GET /readyz` | liveness / readiness (checa o Redis) |

O contrato entre a API e o worker (Redis Streams) está documentado em [apps/api/src/jobs.js](apps/api/src/jobs.js).

### CLI do worker (sem API, para testes)

```powershell
docker compose --profile gpu run --rm worker-gpu "<link>" --lyrics lrclib
docker compose --profile gpu run --rm worker-gpu "<link>" --lyrics text --lyrics-file /storage/inputs/letra.txt
```

## Testes

```powershell
cd apps/worker; python -I -m unittest discover -s tests -t .
cd apps/api;    npm test
cd apps/web;    npm test
```
