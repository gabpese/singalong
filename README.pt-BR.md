# singalong

[English](README.md) · **Português (Brasil)**

Karaokê próprio e colaborativo: pesquise uma música no YouTube e o Singalong gera a versão karaokê (instrumental, letra sincronizada palavra a palavra, troca de tom, vozes de apoio, pontuação pelo microfone e exportação em MP4), com fila compartilhada pelo celular e a TV como player.

Documentação: [PRD](PRD.pt-BR.md) (requisitos do produto), [TRD](TRD.pt-BR.md) (requisitos técnicos e a proposta do instalador/agente) e [PLAN](PLAN.pt-BR.md) (decisões e histórico). Cada um tem também a versão em inglês.

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

### Agente local (marco M0: lado do servidor e transporte do worker)

O **agente local** é o worker rodando no computador do dono e falando com o servidor só por **HTTP de saída** (`/agent/v1`), sem acesso ao Redis. O dono inicia uma **sessão** (com um apelido que os convidados veem), cria as salas dela, e todo pedido de música feito pelo celular de um convidado nessas salas vai para o **agente desse dono** (nunca para o de outra sessão). Desenho e plano: [TRD](TRD.pt-BR.md).

| Rota (`/agent/v1`, `Authorization: Bearer <token do dispositivo>`) | Função |
|---|---|
| `POST /pair/start` (cabeçalho `X-Admin-Token`) · `POST /pair/complete {code, name}` | pareamento: o administrador gera um código de 8 caracteres, de uso único (10 min); o agente o troca por um token de dispositivo |
| `GET /me` · `DELETE /devices/me` | o dispositivo e a sessão ativa dele · revoga este dispositivo |
| `POST /sessions {display_name, resume_id?}` · `DELETE /sessions/:id` · `POST /sessions/:id/rooms` | inicia/retoma/encerra a sessão · cria uma sala nela |
| `POST /heartbeat` | sinal de vida (o dono aparece "online" por 45 s) |
| `POST /jobs/claim {wait_ms}` · `POST /jobs/:id/progress` · `POST /jobs/:id/complete` | jobs de processamento (long-poll, até 25 s) |
| `POST /search/claim` · `POST /search/:id/result` | busca no YouTube feita pelo agente |
| `POST /exports/claim` · `POST /exports/:id/:pitch/state` | exportação de MP4 |

As páginas enviam o código da sala em `X-Room`, para a busca, a troca de letra e a exportação de uma sala irem ao agente da sessão dela. O estado da sala traz `owner: {nickname, online}` (e `null` nas salas sem sessão, que continuam no worker clássico por Redis).

```bash
# no servidor (defina ADMIN_TOKEN; sem ele o pareamento fica desligado): gera um código de uso único
curl -X POST https://SEU_ENDERECO/agent/v1/pair/start -H "X-Admin-Token: $ADMIN_TOKEN"
# no computador do dono (o pacote do worker; Python):
python -m singalong_worker --pair CODIGO --agent-url https://SEU_ENDERECO      # imprime AGENT_TOKEN=...
export AGENT_URL=https://SEU_ENDERECO AGENT_TOKEN=... AGENT_SESSION_NAME="Meu apelido"
python -m singalong_worker --consume        # o agente: inicia a sessão e puxa jobs, buscas e exportações
python -m singalong_worker --create-room    # imprime os links da TV e do anfitrião de uma sala nova na sessão
```

**Testando o agente à mão com Docker** (PowerShell, na raiz do projeto; a interface ainda não mostra o apelido do dono nem o aviso "dono desconectado", só a API):

```powershell
$env:ADMIN_TOKEN = "um-segredo-longo-qualquer"
docker compose up -d --build --wait api redis  # só a API e o Redis (sem o worker clássico); --wait volta quando a API está pronta
# gera o código de uso único, troca por um token de dispositivo e guarda em $env:AGENT_TOKEN
$resp = curl.exe -s -X POST http://localhost:3000/agent/v1/pair/start -H "X-Admin-Token: $env:ADMIN_TOKEN"; $resp   # {"code":"ABCD2345",...}
$code = ($resp | ConvertFrom-Json).code
$out = docker compose --profile cpu run --rm -T worker --pair $code --agent-url http://api:3000
$env:AGENT_TOKEN = ($out | Select-String '^AGENT_TOKEN=').Line.Split('=', 2)[1].Trim()
echo $env:AGENT_TOKEN   # sga_... (47 caracteres). $env: vale só em UM terminal: defina de novo em cada terminal que usar abaixo
# terminal 1: o agente (deixe aberto; use --profile gpu e worker-gpu para ir mais rápido)
docker compose --profile cpu run --rm -p 8765:8765 -e AGENT_URL=http://api:3000 -e AGENT_TOKEN=$env:AGENT_TOKEN -e AGENT_SESSION_NAME="Gabriel" -e AGENT_MEDIA_HOST=0.0.0.0 -e AGENT_MEDIA_PUBLIC=http://127.0.0.1:8765 -e AGENT_ALLOWED_ORIGINS=http://localhost:3000 worker --consume
# terminal 2: uma sala na sessão do agente (imprime os links da TV e do anfitrião)
docker compose --profile cpu run --rm -e AGENT_URL=http://api:3000 -e AGENT_TOKEN=$env:AGENT_TOKEN worker --create-room --agent-url http://api:3000 --public-url http://localhost:3000
```

Depois abra o link da TV, entre na sala como convidado em outra janela, busque e adicione uma música: a busca e o processamento acontecem no agente. Pare o agente com Ctrl+C e a próxima busca avisa que o dono está desconectado. `curl.exe -H "x-client-id: convidado-0001" http://localhost:3000/api/rooms/CODIGO` mostra `owner: {nickname, online}`. Ao subir, o agente também analisa as vozes de apoio das músicas que já estão em `storage/` (lento em CPU), como o worker clássico faz.

**Armazenamento local (marco M1a).** Com o agente, as músicas ficam **no computador do dono** (`storage/`). O agente sobe um **servidor local de mídia** (`http://127.0.0.1:8765/<token aleatório>/cache/<id>/<arquivo>`, só uma lista fixa de arquivos: nunca a voz isolada) e publica para o servidor um **catálogo** das músicas prontas (o `meta.json` e quais arquivos existem) ao iniciar e a cada música, análise de vozes de apoio ou MP4 novos. As músicas, a biblioteca e os links de MP4 da sala passam a apontar para esse servidor local, então a **TV precisa rodar no computador do dono**. O Chrome/Edge pedem uma vez a permissão de *Acesso à rede local* (a TV mostra um aviso explicando); o celular não tem a prévia do instrumental das músicas locais. Testado no Chrome 155 e no Edge 155 (Firefox e Safari não).

| Variável do agente | Padrão | Função |
|---|---|---|
| `AGENT_MEDIA_PORT` | `8765` | porta do servidor local de mídia (tenta as 9 seguintes se estiver ocupada); **`0` desliga** e o servidor usa o armazenamento dele (o comportamento do M0) |
| `AGENT_MEDIA_HOST` | `127.0.0.1` | onde escuta; com Docker use `0.0.0.0` e publique a porta (`-p 8765:8765`) |
| `AGENT_MEDIA_PUBLIC` | — | o endereço que o **navegador** usa quando não é `http://127.0.0.1:<porta>` (Docker: `http://127.0.0.1:8765`) |
| `AGENT_ALLOWED_ORIGINS` | a origem de `AGENT_URL` | origens (a página da nuvem) que podem ler a mídia, separadas por vírgula; com Docker a página é `http://localhost:3000` |

**Login do YouTube e cookies (marco M1b).** O worker (o agente e o clássico) baixa **sem cookie primeiro**, pela sua própria internet, e usa a conta do YouTube **só quando o YouTube pedir login** (confirmação de "não sou um robô", restrição de idade ou um 403): aí repete com os cookies da conta. Vários downloads seguidos pelo IP de casa funcionaram sem a conta; usar uma conta com o yt-dlp pode levá-la a ser restringida, então prefira uma **conta secundária**.

| Variável | Padrão | Função |
|---|---|---|
| `YTDLP_COOKIES_POLICY` | `when-asked` | `when-asked` (conta só quando o YouTube pedir), `always` ou `never` |
| `YTDLP_COOKIES` | — | um `cookies.txt` (formato Netscape) para usar como a conta |
| `YTDLP_COOKIES_BROWSER` | — | lê os cookies de um navegador pelo yt-dlp (`firefox`, `chrome:Profile 1`). **No Windows o Chrome e o Edge não funcionam** (a criptografia dos cookies bloqueia o yt-dlp); o Firefox funciona |
| `AGENT_DATA_DIR` | `~/.singalong` | onde o agente guarda o login dele (`youtube_cookies.txt` e o perfil do navegador) |

As fontes são tentadas nessa ordem: `YTDLP_COOKIES`, `YTDLP_COOKIES_BROWSER` e, por fim, o login do próprio agente:

```powershell
cd apps\worker                                      # o módulo fica aqui
pip install websockets "yt-dlp[default]"            # só o que o login e a verificação precisam
python -m singalong_worker --youtube-login          # abre o Chrome ou o Edge com um perfil só do agente; entre na conta do YouTube
python -m singalong_worker --youtube-login edge     # escolhe o navegador
python -m singalong_worker --youtube-status         # "Conectado" / "Sem login válido" (um pedido que só funciona logado)
```

O `--youtube-login` abre o **seu Chrome ou Edge instalado com um perfil dedicado** (o seu perfil pessoal não é tocado), espera você entrar, pede os cookies ao próprio navegador pelo protocolo de depuração (ele os entrega já descriptografados, por isso funciona onde o yt-dlp não consegue ler o navegador) e guarda só os cookies do YouTube e do Google em `~/.singalong/youtube_cookies.txt`, depois fecha o navegador. Os cookies nunca saem do computador. Se o login nessa janela for recusado, use o Firefox com `YTDLP_COOKIES_BROWSER=firefox` ou um `cookies.txt` exportado de uma janela anônima.

**Importar as suas músicas (marco M1c).** Além do YouTube, dá para trazer um áudio que você já tem ou um link de fonte aberta. Roda no worker, fica neste computador e passa pelo mesmo pipeline (separação de voz, tom, letra).

```powershell
python -m singalong_worker --import "C:\Musicas\musica.mp3" --artist "Artista" --title "Título" [--lyrics lrclib|align|none]
python -m singalong_worker --import-url "https://archive.org/details/<item>" --artist "Artista" --title "Título"
```

Formatos: mp3, flac, wav, m4a, ogg, opus (tamanho até `IMPORT_MAX_MB`, 200 por padrão, e 15 minutos). Links: só SoundCloud, Bandcamp e Internet Archive, faixas avulsas, sem cookies. Artista e título saem das etiquetas se você não informar. Se `AGENT_URL` e `AGENT_TOKEN` estiverem definidos, a música também é publicada no catálogo do agente e aparece na biblioteca da sala. O app não verifica a origem do arquivo: importe só o que você tem direito de usar.

**Versão, hardware e pacote do motor (marco M2).**

```powershell
python -m singalong_worker --version                                       # versão instalada
python -m singalong_worker --check-update --agent-url https://seu-servidor # há uma versão mais nova?
python -m singalong_worker --hardware [--selftest]                         # GPU/CPU e o motor recomendado; --selftest faz um teste real na GPU
cd apps\engine
node src\cli.js assemble --dir D:\Singalong\engine [--engine auto|cpu|cu121]   # monta o motor (Python, ffmpeg, deno, torch...) a partir das fontes oficiais
node src\cli.js verify   --dir D:\Singalong\engine
```

O `assemble` precisa só do Node 22+ e do Windows 10/11 (usa o `tar.exe` do próprio Windows); nada é instalado no sistema e, se for interrompido, continua de onde parou. O motor `cu121` ocupa cerca de 5,6 GB. No servidor, `APP_LATEST_VERSION`, `APP_MIN_VERSION`, `APP_NOTES` e `APP_DOWNLOAD_URL` definem o aviso de atualização (abaixo da mínima, o agente deixa de receber jobs até atualizar).

**O app do dono (marco M3).** Uma janela Electron que faz tudo isso sem terminal: prepara o motor, pareia, inicia a sessão, cria salas, entra no YouTube e importa arquivos.

```powershell
cd apps\desktop
npm install
npm start                # abre o app (o motor é montado na primeira vez; o pareamento pede um código do administrador do servidor)
npm test                 # os testes do controlador
$env:SINGALONG_TEST_PYTHON = "C:\caminho\para\python.exe"   # um Python com numpy, langdetect, websockets e yt-dlp
npm run test:e2e         # a janela de verdade + a API de verdade + o worker de verdade
```

Os seus dados (configuração, motor, biblioteca) ficam em `%APPDATA%\Singalong Karaoke`. Fechar a janela com a sessão rodando só a esconde (o ícone da bandeja a traz de volta; "Sair" encerra a sessão).

### CLI do worker (sem API, para testes)

```powershell
docker compose --profile gpu run --rm worker-gpu "<link>" --lyrics lrclib
docker compose --profile gpu run --rm worker-gpu "<link>" --lyrics align --lyrics-file /storage/inputs/letra.txt
```

## Robustez (configuração)

Variáveis opcionais (no `.env` ou no ambiente; `0` desliga o limite):

| Variável | Padrão | O que faz |
|---|---|---|
| `MAX_DURATION_SECONDS` | 900 | recusa vídeos mais longos (antes de baixar) |
| `MIN_FREE_GB` | 2 | recusa processar com pouco disco livre |
| `SEPARATE_TIMEOUT_SECONDS` | 900 | tempo máximo da separação (Demucs) |
| `WORKER_MAX_ATTEMPTS` | 3 | tentativas automáticas só para falhas passageiras (rede, 429) |
| `CACHE_MAX_GB` | 20 | acima disso apaga as músicas cantadas há mais tempo (nunca as da fila) |
| `LOG_LEVEL` | info | nível dos logs (JSON no Docker) |

Erros do YouTube viram mensagens em português; "Tentar de novo" só aparece quando vale a pena (não para vídeo privado, bloqueado ou longo demais). Há limite de pedidos por pessoa (busca, fila, criar sala), `/readyz` detalha Redis, banco e armazenamento, e o worker tem healthcheck por heartbeat.

## CI/CD e hospedagem

- **CI** (`.github/workflows/ci.yml`): a cada push e pull request roda os testes da API, do front-end (TypeScript, unitários, build e ponta a ponta com Playwright) e do worker, e confere que as imagens constroem.
- **CD** (`.github/workflows/deploy.yml`): depois do CI verde na `main`, publica a imagem da API no GitHub Container Registry (amd64 e arm64) e, se ligado, atualiza a VM por SSH.
- **Hospedagem gratuita com HTTPS** para acessar de qualquer computador, sem o seu PC ligado: veja [`deploy/README.md`](deploy/README.md).

## Testes

```powershell
cd apps/worker; python -I -m unittest discover -s tests -t .
cd apps/api;    npm test
cd apps/web;    npm test            # lógica pura (node:test)
cd apps/web;    npm run typecheck   # TypeScript
cd apps/web;    npm run build; npm run e2e   # testes de ponta a ponta (Playwright, contra o build em dist/)
```

Os testes de ponta a ponta sobem sozinhos uma API de teste (`apps/web/e2e/server.mjs`, com músicas prontas e fila de jobs em memória) e abrem um Chromium de verdade, com microfone falso. Na primeira vez: `npx playwright install chromium`.

## Desenvolvimento do front-end

O front-end é React + TypeScript com Vite, em `apps/web` (páginas `index.html`, `room.html` e `tv.html`; código em `src/`). Com a API rodando em `localhost:3000`:

```powershell
cd apps/web; npm install; npm run dev     # http://localhost:5173, com recarga rápida; /api e /media vão para a API
```

A imagem da API constrói o front-end (`vite build`) e serve o resultado; fora do Docker, rode `npm run build` e a API serve `apps/web/dist`.
