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

- O **link de anfitrião** (menu ⋯ da sala) deixa outro aparelho controlar a sala. Quem tem o link manda.
- A **TV** mostra, no alto, **quem está cantando agora → o próximo cantor** (o mesmo que o servidor vai tocar: pronto e respeitando o rodízio justo), e, ao lado, a **lista com a música atual e as 5 próximas** ("+ N na fila" para o resto), mais uma barra de progresso.
- **Aviso de pausa:** em pausas da letra de **8 s ou mais** (introdução, solo, ponte) a TV mostra `--------------` no lugar da linha atual, com a próxima letra já embaixo. Nos **últimos 8 s** os traços vão sumindo, para o cantor ver quando a linha começa. Em letras com tempo só no início de cada linha (LRC), um solo fica "dentro" da linha anterior; o app estima quanto a linha leva para ser cantada (~0,12 s por letra + 2 s) e trata o resto como pausa.
- **Ceder a vez:** quem precisa se ausentar (ir ao banheiro, por exemplo) toca em **⇩ Ceder a vez** na própria música e ela **desce uma posição**: a pessoa de trás canta antes. Pode repetir. Só o anfitrião pode *subir* uma música (senão qualquer um furaria a fila).
- O **tom da música** é detectado sozinho e aparece só como a **nota**, sem maior/menor (o modo não muda ao transpor): "Lá (A)", "Dó♯ / Ré♭ (C#/Db)". Ao subir ou descer o tom de canto, mostra qual nota você vai cantar: "Lá (A) → Si (B) com +2". É uma **estimativa**: quando o app não tem certeza, mostra as duas candidatas ("Tom provável: Fá (F) ou Ré (D)").
- O **tom de canto** (−6 a +6 semitons) é por música na fila e muda ao vivo. O **ajuste da letra** vale para a música em qualquer sala.
- **Prévias no celular:** ao pesquisar, o botão **▶ Prévia** (ou **Ouvir no YouTube**, para um link colado) toca o vídeo original para você conferir se é a música certa. Com a música já preparada, **▶ Prévia** na fila toca o **instrumental com o tom escolhido**, e mexer no tom ali muda o tom da sua música na fila. (A prévia do instrumental funciona em http pelo IP da rede.)
- O celular tem três abas: **Fila**, **Adicionar** e **Músicas** (já processadas). Na aba **Músicas** há um **filtro por artista e nome**: ignora maiúsculas e acentos, aceita várias palavras em qualquer ordem ("elfman jack" acha "Jack's Lament", de Danny Elfman) e mostra "3 de 12". A lista fica em ordem alfabética por artista; as sem artista vão para o fim.
- Salas paradas há 24 horas são apagadas. Recarregar a TV no meio de uma música retoma de onde estava.

### Adicionar uma música

Informe **Artista** e **Nome da música** (os dois são obrigatórios). Com eles o app:

1. **pesquisa o vídeo no YouTube** com `Artista - Nome da música`: toque em **🔎 Buscar no YouTube**, use **▶ Prévia** para ouvir e escolha o vídeo certo (quem já tem o link usa **Já tenho o link do vídeo**);
2. **busca a letra** com os mesmos dois campos (opção "Buscar a letra na internet", a padrão).

A letra pode vir de:

| Opção na tela | O que faz |
|---|---|
| Usar a legenda do vídeo, se ele tiver | usa a legenda **manual** do YouTube (auto-legendas são ignoradas de propósito) |
| Buscar a letra na internet | procura a letra no [LRCLIB](https://lrclib.net) por artista + nome da música. Se existe uma versão **com tempos e de mesma duração**, usa; senão (comum em covers) pega o **texto** e a IA o sincroniza com a voz |
| Colar a letra e sincronizar com a voz (IA) | **a saída para covers e vídeos sem referência de tempo**: você cola a letra (uma linha por verso) e a IA (Whisper, em modo "alinhar texto") descobre quando cada linha é cantada, ouvindo a voz isolada. Não gera letra |
| Cantar sem letra | só o instrumental: **sempre** funciona, mesmo quando nada acima serve |
| Avançado: letra que já tem tempos | conteúdo de um arquivo `.lrc` ou `.srt` |

- Sem letra utilizável, a música fica na fila com **"Precisa de letra"** e um botão **Escolher letra**; o instrumental já
  processado é reaproveitado (só a letra é refeita).
- Em covers e vídeos produzidos (com créditos, por exemplo) a duração difere da versão original, que não serve de tempo:
  a IA sincroniza o texto com a voz do vídeo (cerca de 1 minuto na primeira vez).
- Músicas já processadas (aba **Músicas**) entram na fila sem pedir artista e nome.
- **Por que a letra não vem do Google/Musixmatch?** O Google bloqueia acesso automatizado (captcha "unusual traffic") e a
  API oficial da Musixmatch, no plano gratuito, devolve só **30% da letra** (a inteira exige licença paga). Por isso o texto
  vem do LRCLIB (API aberta, que tem as músicas testadas). O texto é só o ponto de partida: quem marca os tempos é a IA.
- A legenda do vídeo depende do YouTube liberar o download dela; quando ele limita (HTTP 429), o job segue sem ela.

Tudo fica em `storage/cache/<video_id>/` (`instrumental.mp3`, `vocals.mp3`, `lyrics.json`, `meta.json` com o tom, `source.json`).
Salas e fila ficam num SQLite no volume `api-data` do Docker.

### API

| Rota | Função |
|---|---|
| `POST /api/rooms` | cria a sala: `{code, host_token}` |
| `GET /api/rooms/:code` | estado: fila, o que toca, `tv_connected`, `me.is_host` |
| `POST /api/rooms/:code/queue` `{url \| video_id, lyrics?, artist?, title?, name?, pitch?}` | adiciona à fila (e já pede o processamento) |
| `DELETE /api/rooms/:code/queue/:item` · `POST …/move {direction}` · `PATCH …/queue/:item {pitch}` | remover · mover (`down` = ceder a vez, o dono pode; `up` só o anfitrião) · tom |
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
