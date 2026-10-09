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

## Como funciona uma festa

1. **Criar a sala** (na página inicial). Você vira o **anfitrião** e a **TV** abre em outra aba.
2. **A TV** (`tv.html`) é o navegador que toca: abra-a no computador ligado à TV, **por `http://localhost:3000`** (a troca de
   tom precisa de contexto seguro: localhost ou https). Enquanto não há música, ela mostra o código da sala e um **QR code**.
   Se o navegador pedir, clique em "Toque aqui para ativar o som" (uma vez).
3. **Os celulares** entram pelo QR code ou digitando o código, e cada pessoa adiciona suas músicas. Para o QR funcionar nos
   celulares, informe o endereço do computador na rede: `$env:PUBLIC_URL="http://192.168.0.10:3000"` antes do `docker compose up`.
4. A fila toca sozinha. **Enquanto uma música toca, a próxima já está sendo preparada** (baixar, separar a voz, achar/alinhar
   a letra). Se a próxima ainda não ficou pronta, toca a seguinte que já esteja pronta, e a atrasada mantém o lugar.

| Quem | O que pode |
|---|---|
| Qualquer pessoa na sala | adicionar músicas, remover e mudar o tom **das próprias** músicas, ver a fila |
| Anfitrião | tudo isso **em qualquer música**, mais pular, pausar/retomar, reordenar (▲▼), ajustar a letra e ligar o **rodízio justo** (a mesma pessoa não canta duas seguidas quando há outra esperando) |

- O **link de anfitrião** (botão no topo da sala) deixa outro aparelho controlar a sala. Quem tem o link manda.
- O **tom** (−6 a +6 semitons) é por música na fila e muda ao vivo. O **ajuste da letra** vale para a música em qualquer sala.
- Salas paradas há 24 horas são apagadas. Recarregar a TV no meio de uma música retoma de onde estava.

### Adicionar uma música

Digite o nome (pesquisa no YouTube) ou cole um link, e escolha a letra:

| Opção na tela | O que faz |
|---|---|
| Usar a legenda do vídeo, se ele tiver | usa a legenda **manual** do YouTube (auto-legendas são ignoradas de propósito) |
| Buscar a letra na internet | procura a letra no [LRCLIB](https://lrclib.net) por artista + nome da música. Se existe uma versão **com tempos e de mesma duração**, usa; senão (comum em covers) pega o **texto** e a IA o sincroniza com a voz |
| Colar a letra e sincronizar com a voz (IA) | **a saída para covers e vídeos sem referência de tempo**: você cola a letra (uma linha por verso) e a IA (Whisper, em modo "alinhar texto") descobre quando cada linha é cantada, ouvindo a voz isolada. Não gera letra |
| Cantar sem letra | só o instrumental: **sempre** funciona, mesmo quando nada acima serve |
| Avançado: letra que já tem tempos | conteúdo de um arquivo `.lrc` ou `.srt` |

- Sem letra utilizável, a música fica na fila com **"Precisa de letra"** e um botão **Escolher letra**; o instrumental já
  processado é reaproveitado (só a letra é refeita).
- Em covers, informe **Artista** e **Nome da música** para a busca online. A letra de uma versão de duração diferente
  não serve de tempo, então a IA a sincroniza com a voz do vídeo (cerca de 1 minuto na primeira vez).
- **Por que não buscamos no Google?** O Google bloqueia acesso automatizado (captcha "unusual traffic"), então a letra é
  buscada no LRCLIB, que tem o texto das músicas testadas. O texto é só o ponto de partida: quem marca os tempos é a IA.
- A legenda do vídeo depende do YouTube liberar o download dela; quando ele limita (HTTP 429), o job segue sem ela.

Tudo fica em `storage/cache/<video_id>/` (`instrumental.mp3`, `vocals.mp3`, `lyrics.json`, `meta.json`, `source.json`).
Salas e fila ficam num SQLite no volume `api-data` do Docker.

### API

| Rota | Função |
|---|---|
| `POST /api/rooms` | cria a sala: `{code, host_token}` |
| `GET /api/rooms/:code` | estado: fila, o que toca, `tv_connected`, `me.is_host` |
| `POST /api/rooms/:code/queue` `{url \| video_id, lyrics?, artist?, title?, name?, pitch?}` | adiciona à fila (e já pede o processamento) |
| `DELETE /api/rooms/:code/queue/:item` · `POST …/move {direction}` · `PATCH …/queue/:item {pitch}` | remover · reordenar (anfitrião) · tom |
| `POST /api/rooms/:code/player/{pause,resume,skip}` · `PATCH /api/rooms/:code {fair}` | controle (anfitrião) |
| `PUT /api/rooms/:code/songs/:id/offset {offset}` | ajuste da letra, em segundos (anfitrião) |
| `WS /api/rooms/:code/ws?role=tv\|controller` | estado em tempo real; a TV envia `ended` e `position` |
| `GET /api/search?q=` | pesquisa vídeos no YouTube (atendida pelo worker; cache de 10 min) |
| `POST /api/songs` · `GET /api/songs` · `GET /api/songs/:id` · `PUT /api/songs/:id/lyrics` | músicas e processamento (usados pela sala) |
| `GET /media/cache/<id>/...` | arquivos, com `Range` |
| `GET /healthz`, `GET /readyz` | liveness / readiness (checa o Redis) |

Os pedidos levam `X-Client-Id` (id do navegador) e, para o anfitrião, `X-Host-Token`.
O contrato entre a API e o worker (Redis Streams) está documentado em [apps/api/src/jobs.js](apps/api/src/jobs.js).

### CLI do worker (sem API, para testes)

```powershell
docker compose --profile gpu run --rm worker-gpu "<link>" --lyrics lrclib
docker compose --profile gpu run --rm worker-gpu "<link>" --lyrics align --lyrics-file /storage/inputs/letra.txt
```

## Testes

```powershell
cd apps/worker; python -I -m unittest discover -s tests -t .
cd apps/api;    npm test
cd apps/web;    npm test
```
