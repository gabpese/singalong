# Singalong — Documento de Requisitos Técnicos (TRD)

[English](TRD.md) · **Português (Brasil)**

Versão 0.1 · Out/2026 · Complementa o [PRD.pt-BR.md](PRD.pt-BR.md) e o [PLAN.pt-BR.md](PLAN.pt-BR.md) (decisões e histórico). Este documento descreve a arquitetura **atual** (seção 2) e a **proposta** do agente local com instalador (seções 3 a 10).

## 1. Escopo

Fazer o Singalong funcionar em duas partes: um **servidor** central (hoje, a VM gratuita da Oracle) e um **agente local** instalado no computador do usuário, que baixa do YouTube pela internet dele e processa o áudio. O usuário instala o agente sem Docker, Python ou terminal.

## 2. Arquitetura atual (como está construída)

```
[Celular]──┐                 ┌─ Fastify API (Node 24) ── SQLite (salas, fila)
           ├─ HTTPS/WS ──────┤         │
[TV]───────┘      (Caddy)    └─ /media (Range) ── storage/cache/<video_id>/
                                       │
                                    Redis ◄── worker Python (puxa): yt-dlp • Demucs • Whisper • UVR • ffmpeg
```

- **API**: salas, fila, WebSocket, `/media`, busca e jobs via Redis (contrato em `apps/api/src/jobs.js`). Nunca chama o worker; o worker sempre **puxa** (funciona atrás de NAT).
- **Worker**: consome o stream `jobs` (consumer group), atende `search:req` e `export:req` em threads próprias e a análise de vozes de apoio em outra. A lógica de um job (`runner.py`) não depende do cliente Redis (recebe um objeto com `hset/hincrby/expire/xack`).
- **Armazenamento**: driver `local` (pasta `storage/`), chaves lógicas `cache/<id>/{instrumental.mp3, vocals.mp3, lyrics.json, meta.json, melody.json, backing.mp3, source.json}`.
- **Hoje**: o worker roda em Docker no PC do dono (perfil `gpu` ou `cpu`); a nuvem só toca a biblioteca copiada por `deploy/sync-library.sh`, porque o YouTube bloqueia o IP da Oracle (medido: 0 de 8 downloads sem cookie).

## 3. Arquitetura proposta

```
 Nuvem (Oracle, gratuita)                         Computador do usuário
┌──────────────────────────────┐  HTTPS (só saída)  ┌────────────────────────────────────┐
│ Caddy → API → SQLite / Redis │◄───────────────────│ Agente Singalong (Electron, bandeja)│
│  • salas, fila, TV, celular  │  claim/progress/   │  └─ Motor (Python embutido)         │
│  • API do agente (/agent/v1) │  complete/upload   │      yt-dlp • ffmpeg • Demucs •     │
│  • biblioteca na nuvem       │                    │      Whisper • UVR   (CPU ou NVIDIA)│
└──────────────────────────────┘                    │  Biblioteca local (pasta escolhida) │
                                                    └────────────────────────────────────┘
```

Princípios:
1. **O agente só faz conexões de saída** (sem abrir portas, funciona atrás de NAT/roteador).
2. **A nuvem nunca recebe cookies**. O agente também **não obedece a comandos arbitrários**: o servidor manda só `video_id` e opções de um conjunto fechado (seção 8).
3. **O motor reaproveita o código do worker atual**, trocando só o transporte (Redis → HTTP), sem reescrever o pipeline.
4. **GPU é opcional**: o mesmo motor roda em CPU (seção 6).
5. **Uma sessão = um dono = uma conta do YouTube** (seção 3.1). Todo pedido de música feito por um celular é executado pelo agente do dono da sessão da sala.

### 3.1 Sessão, salas e quem baixa (decidido)

**Modelo:** `Sessão { id, device_id (o agente do dono), perfil do YouTube, rooms[] }`. A sessão começa no app do dono, que **entra com o YouTube antes de qualquer download** (seção 8).

- **Salas pertencem a uma sessão** (`rooms.session_id`). O dono cria a sala pelo app e o navegador abre a página dela já como anfitrião.
- **Os celulares entram na sala pelo QR code, como hoje.** Quando um convidado pede uma música, a API cria o job e o **roteia para a sessão da sala**: só o agente dono dessa sessão consegue reivindicá-lo (`claim` filtra por `session_id`). O convidado nunca vê nem usa a conta do dono.
- **Dono offline:** o job fica na fila e a sala mostra "o dono da sessão está desconectado" (detectado pelo `heartbeat`). Músicas já locais continuam tocando na TV do próprio dono.
- **Fim da sessão:** ao sair do app, a sessão é encerrada; as salas seguem a regra atual (apagadas após 24 h paradas).
- **O que a nuvem sabe da conta:** só um **apelido de exibição**, escolhido pelo dono ao iniciar a sessão (é o que os convidados veem), e se a sessão está "conectada". Nunca cookies, e-mail ou senha.
- **Servidor:** novas tabelas `sessions(id, device_id, display_name, created_at, last_seen)` e a coluna `rooms.session_id`; o stream de jobs passa a levar `session_id`.
- **Papel da nuvem:** com o armazenamento local (seção 5), a nuvem vira o **ponto de encontro**: salas, fila, celulares, WebSocket e a API do agente. Ela não guarda músicas.

## 4. API do agente (nova, no servidor)

Prefixo `/agent/v1`, autenticada por **token de dispositivo** (`Authorization: Bearer`). O servidor continua sendo o único que fala com o Redis.

| Rota | Função |
|---|---|
| `POST /sessions` · `DELETE /sessions/:id` | Inicia/encerra a sessão do agente (só apelido de exibição, sem dados da conta) |
| `POST /pair/start` · `POST /pair/complete` | Pareamento: a página web mostra um **código de 8 caracteres (10 min)**; o agente o envia e recebe o token (guardado no cofre do sistema: Credential Manager no Windows) |
| `POST /jobs/claim` (long-poll, 25 s) | Entrega o próximo job `{video_id, lyrics_source, lyrics_text?, artist?, title?}`, com reivindicação com expiração (visibility timeout), como o `XAUTOCLAIM` de hoje |
| `POST /jobs/:id/progress` | `{status, stage, error?, error_code?, retry?}` (mesmo conteúdo do hash `job:<id>`) |
| `POST /jobs/:id/complete` | Marca `ready` ou `needs_lyrics` |
| `PUT /library/:id/:file` | **Só no modo híbrido (M5):** envia um artefato para a nuvem quando a música é publicada (seção 5); atômico (`.tmp` + rename), limite de tamanho, só nomes permitidos |
| `POST /search/claim` · `POST /search/:id/result` | Busca no YouTube feita pelo agente (substitui `search:req/res`) |
| `POST /exports/claim` · `POST /exports/:id/result` | Exportação de MP4 |
| `POST /heartbeat` | Versão do agente, hardware detectado, fila local; a página web mostra "agente conectado"; a resposta traz o aviso `update` (seção 7) |
| `GET /version?current=X` | Aberto (sem token): `ok`, `update_available` ou `update_required`, com as versões mais recente/mínima, uma nota e o link de download |
| `DELETE /devices/:id` | O dono revoga um dispositivo |

No agente, a mudança de código é pequena: `runner.process` já é independente do cliente Redis. Cria-se uma interface `JobBackend` com duas implementações (`RedisBackend`, a atual, e `HttpBackend`, nova). O Redis continua existindo no servidor e no modo Docker de desenvolvimento.

## 5. Armazenamento: onde ficam os arquivos (decidido: local primeiro; híbrido depois)

**Decisão (Out/2026):** a v2 usa o **modo A, só local**; o modo C (híbrido) é planejado depois (v2.1). A tabela abaixo mostra as três opções e por que a ordem.

A ideia de guardar tudo no computador do usuário e o player ler o arquivo local tem uma limitação de navegador:

- A página do karaokê vem de **`https://singalong…`** e o arquivo está em `http://…` no computador do agente. Os navegadores com a permissão de "Acesso à rede local" (*Local Network Access*, [fonte](https://developer.chrome.com/blog/local-network-access)) pedem ao usuário que a aceite antes de a página falar com a máquina local.
- **Testado em Out/2026 (Chrome 155 e Edge 155 instalados, mais o Chromium do Playwright), a partir da página pública real:**
  - **Sem a permissão**, o pedido não chega ao servidor local. Com a janela do Chrome visível, ele fica **pendente**: o Chrome mostra o aviso e espera o usuário; sem janela (automação), é bloqueado.
  - **Com a permissão**, tudo o que o player usa funciona, em `http://127.0.0.1`, `http://localhost` e até em um **endereço da rede local** (`http://192.168.x.x`): `fetch` da letra e da melodia, `<audio crossOrigin="anonymous">`, Web Audio (`createMediaElementSource`), tocar e saltar (pedidos `Range`). Os navegadores deixaram de tratar o endereço da rede local como conteúdo misto bloqueado.
  - **O preflight de rede privada (`Access-Control-Allow-Private-Network`) não chegou a ser pedido:** no Chrome atual a permissão o substitui. Continuam necessários os cabeçalhos **CORS** (`Access-Control-Allow-Origin` com a origem exata, `Vary: Origin`, `Expose-Headers` de `Content-Range`/`Accept-Ranges`) e o suporte a `Range`.
  - **Não testado:** Firefox e Safari (inclusive o do iPhone, que não segue esse modelo). Por isso a prévia do instrumental no celular continua fora da v2.
- **Decisão (M1):** o servidor local de mídia escuta em `127.0.0.1` e a TV roda no computador do dono. A primeira vez, o Chrome pergunta se a página pode acessar "dispositivos na rede local": o app mostra um passo simples explicando para tocar em **Permitir** (a escolha fica guardada para o site). Como o endereço da rede local também funciona com a permissão, uma TV **em outro aparelho Chromium da mesma rede** é uma opção futura, sem mudar o desenho.
- **O servidor local do agente** responde em `http://127.0.0.1:<porta>/media` com `Range`, CORS para a origem da nuvem e `Access-Control-Allow-Private-Network: true`.
- **Limitações do modo A:** a **prévia do instrumental no celular** não funciona (o celular não alcança o arquivo); a prévia do vídeo do YouTube continua. O PC do dono precisa estar ligado para tocar e para baixar.
- A música que **já está na nuvem** (a biblioteca atual, copiada com `sync-library.sh`) continua tocando de qualquer lugar até o híbrido existir.

| Modo | Como funciona | Toca em qualquer lugar? | Custo/risco |
|---|---|---|---|
| **A. Só local (v2, decidido)** | O agente serve `http://localhost:<porta>/media`; a sala e a TV rodam no mesmo PC | Não | Zero; sem arquivos de terceiros na nuvem |
| **B. Nuvem** | O agente envia os arquivos para a VM (`PUT /library`); o player lê da nuvem | **Sim** | Disco da VM (45 GB livres; ~7 MB/música) e arquivos protegidos num servidor |
| **C. Híbrido (v2.1)** | A música fica sempre na biblioteca local; **publicar na nuvem é opcional, por música** ("Levar para a nuvem") | Só as publicadas | Escolha do usuário; o servidor só guarda o que foi publicado |

O caso "ir à casa do meu irmão" **exige o modo B/C** para as músicas que se quer levar. Em todos os modos, a **pontuação, o tom e as vozes de apoio** continuam funcionando, pois dependem só dos arquivos e do player.

## 6. Hardware e aceleração (pergunta: "só funciona com a minha placa?")

**Não está presa a um modelo.** O código escolhe o dispositivo automaticamente (`DEMUCS_DEVICE` vazio = automático; o Whisper do alinhamento também). O que existe é **uma imagem para CPU e outra para NVIDIA**, escolhidas pelo `TORCH_INDEX` (`cpu` ou `cu121`, torch 2.5.1). Resultado hoje:

| Hardware | Suporte atual | Observações |
|---|---|---|
| **NVIDIA** (GTX 900 até RTX 40) | ✅ GPU (CUDA 12.1) | Medido na RTX 3060: faixa de 3:42 separada em ~8 s |
| **NVIDIA RTX 50 (Blackwell)** | ⚠️ A verificar | O torch 2.5.1/cu121 provavelmente **não tem kernels** para essa arquitetura (exige builds mais novos, CUDA 12.8). O instalador deve **testar** a GPU e cair para CPU se falhar |
| **AMD / Intel (GPU)** | ❌ usa a CPU | ROCm no Windows é limitado; DirectML fica como ideia (F27) |
| **Apple Silicon** | ❌ usa a CPU (futuro: MPS) | Demucs suporta MPS; fica para a v3 |
| **Só CPU** | ✅ | Mais lento: a separação leva minutos por música; as vozes de apoio (onnxruntime) já rodam **só em CPU** hoje (~1 a 1,5 min/música) |

Requisitos mínimos propostos (**a medir** com testes reais antes de publicar): Windows 10/11 64 bits, 8 GB de RAM, 4 núcleos, ~10 GB livres (motor de IA + modelos: Demucs ~80 MB, Whisper `small` ~460 MB, UVR ~53 MB; o torch sozinho ocupa alguns GB).

**Sondagem de hardware (no instalador e a cada atualização):** detectar GPU NVIDIA (driver ≥ o exigido pelo CUDA 12.1) → instalar o motor `cu121` → rodar um **teste real** (uma convolução pequena na GPU). Se falhar, instalar/usar o motor `cpu` e avisar. O usuário pode forçar a CPU nas configurações.

## 7. Empacotamento e instalador

**Decisão proposta: casca Electron + "pacote do motor" baixado na primeira execução.**

| Opção | Prós | Contras | Veredito |
|---|---|---|---|
| **Electron** (casca) | Stack já é JS/TS/React; bandeja, auto-update (`electron-updater`), `child_process` para o motor | ~100 MB base | **Escolhida** |
| Tauri | Muito leve | Exige Rust; a leveza some perto de alguns GB do torch | Alternativa |
| Node SEA/`pkg` puro | Pequeno | Não resolve o Python/torch; sem interface | Só para modo "sem interface" |
| PyInstaller de tudo | Um `.exe` | Torch + CUDA gigante e frágil | Descartada |
| Docker para o usuário | Já funciona | WSL2 + Docker Desktop: pesado e confuso para leigo | Descartada |

- **Instalador** (Windows, NSIS ou MSI via `electron-builder`): pequeno (~100 MB), instala por usuário (sem administrador) em `%LOCALAPPDATA%`. **O arquivo se chama `singalong_karaoke.exe`** (definido no `electron-builder`, `artifactName`). **Por ora não é publicado nem hospedado**: fica só na máquina do dono. Se um dia for compartilhado, usar um **link privado** (as Releases de um repositório público são públicas, então não servem).
- **Pacote do motor** (baixado na 1ª execução, com barra de progresso, retomável, com **checksum SHA-256**): Python embutido (python-build-standalone) + torch (cpu **ou** cu121) + dependências + `ffmpeg` + `yt-dlp` + `deno` (exigido pelo yt-dlp para resolver os desafios do YouTube). **Decidido: montado no computador do usuário.** O instalador baixa cada componente da **fonte oficial** (PyTorch, yt-dlp, ffmpeg, deno, python-build-standalone), em versões e **checksums fixados**, em vez de nós hospedarmos e redistribuirmos o pacote de GBs. Assim não pagamos nem mantemos hospedagem do pacote, e as obrigações de licença (a GPL do ffmpeg) ficam mais simples. Contrapartida: depende de as fontes oficiais estarem no ar (mitigado pelas versões fixas, checksum e novas tentativas).
- **Atualização:** o agente (auto-update) e o **yt-dlp** (verificado a cada início; é o que mais quebra) atualizam sozinhos, com versão mínima exigida pelo servidor (`/heartbeat` responde "atualize").
- **Versão e aviso de atualização (decidido):** o app tem um único número de versão (`MAIOR.MENOR.CORREÇÃO`) lido pelo instalador, pela interface e pelo agente. A cada abertura o agente envia a sua versão ao servidor (`/agent/v1/version`), que responde a versão **mais recente**, a **mínima** que ainda aceita e uma nota curta do que mudou. Existe versão nova → o app mostra "atualização disponível" com a nota; abaixo da mínima → pede para atualizar antes de processar (o servidor também recusa jobs dele). Assim não é preciso instalar do zero a cada mudança: a interface baixa o novo instalador (`electron-updater`, pelo link privado da seção 7) e o pacote do motor só é remontado quando os componentes fixados mudam. Os números mais recente/mínima ficam no servidor (arquivo/variável que o dono edita); publicar uma correção é: gerar, subir no link privado e subir o `latest`.
- **Assinatura de código:** como o instalador **não será distribuído publicamente** e o custo é zero, **não assinamos**. As poucas pessoas que o receberem verão o aviso do Windows (SmartScreen) e escolhem "Mais informações → Executar assim mesmo"; o guia de instalação explica isso.
- **ffmpeg vai dentro do pacote do motor** (o usuário não instala nada e o app **não depende** de um ffmpeg que ele já tenha). É usado por: o yt-dlp (extrair o áudio), a separação de voz (ler e gravar áudio, MP3 com `libmp3lame`), o alinhamento e a análise de tom/melodia (decodificar áudio) e a **exportação de MP4** (`libx264`, `aac`, o filtro `rubberband` para o tom e `libass` para queimar a letra). Fica na pasta do app, **fora do PATH**, e o motor o chama pelo caminho completo. Tamanho: ~80 a 190 MB, conforme a build.
- **Qual build:** como precisamos de `libx264`, `libass` e `rubberband`, a build tem de ser **GPL** (a LGPL não os inclui). Usar uma build GPL já compilada para Windows (gyan.dev ou BtbN, no GitHub, gratuitas), **fixar a versão e o SHA-256** e conferir na montagem do pacote que ela contém esses codecs e filtros (`ffmpeg -encoders`, `-filters`). Rodando como **programa separado** (não ligado ao nosso código), o ffmpeg continua GPL e o nosso código mantém a sua licença; é preciso incluir o aviso de licença e o link do código-fonte. Se um dia quisermos evitar a GPL, a alternativa é uma build LGPL com OpenH264 ou o encoder de hardware (perdendo `rubberband` e `libass`, o que obrigaria a trocar o jeito de fazer o tom e a legenda).
- **Licenças:** yt-dlp (Unlicense), Demucs (MIT), pesos de modelos com licenças próprias: **revisar uma a uma** antes de redistribuir.

## 8. Download do YouTube e login da sessão

**Decisão (Out/2026):** o login do YouTube é pedido **no início da sessão**, antes de qualquer download, para nunca tentar, falhar e só então pedir. A conta escolhida baixa para **todas** as salas da sessão (seção 3.1).

**Política de uso do login (decidida após teste):** o agente baixa **sem cookie primeiro**, pela internet residencial do usuário, e usa o login **só quando o YouTube bloquear** (pedir login ou responder 403). Num teste no PC do dono, sem cookies, o yt-dlp 2026.08.19 resolveu 6 de 6 vídeos e baixou 3 de 3 com o cliente padrão (houve um 403 isolado; é intermitente). Assim o login fica **pronto desde o início** (sem interromper ninguém), mas a conta fica pouco exposta. Dá para mudar nas configurações para "sempre usar o login".

**Fluxo de login ("Entrar com o YouTube")**
1. O app abre o **navegador padrão** do usuário na página de login do YouTube. **Não pode ser uma janela embutida do app:** o Google **bloqueia o login em navegadores embutidos**, como o Electron ("This browser or app may not be secure"; [política do Google](https://www.bleepingcomputer.com/news/security/google-to-block-logins-from-embedded-browser-frameworks), [guia sobre Electron](https://www.todesktop.com/docs/application/google-oauth-screen)).
2. O usuário entra (ou já está logado) e, no app, **escolhe o navegador e o perfil** onde fez isso.
3. O agente usa o recurso nativo do yt-dlp **`--cookies-from-browser`** para ler a sessão desse navegador. O OAuth do Google **não serve**: ele dá um token de API, não o cookie de sessão que o yt-dlp usa.
4. **Validação:** o app faz um pedido que só funciona logado (a definir e testar no M1) e mostra "Conectado" ou pede para tentar de novo. Só então a sessão pode baixar.
5. **Sessão vencida:** os cookies do YouTube giram com frequência (sobretudo com abas do YouTube abertas). O agente valida antes de cada job e, se venceu, avisa o dono ("entre de novo") e o job espera. Uma forma citada na wiki do yt-dlp é exportar os cookies de uma **janela anônima** que nunca mais é aberta.

**Cuidados e limitações**
- **Risco à conta.** O yt-dlp avisa que usar uma conta com ele pode levá-la a ser restringida ou banida, e recomenda pouca taxa de pedidos e, se possível, uma conta descartável ([wiki do yt-dlp](https://lab.trianta.dev/mirrors/yt-dlp.yt-dlp/wiki/Extractors)); há também relatos de bloqueio de IP ligado a cookies ([Pinchflat](https://github.com/kieraneglin/pinchflat/wiki/YouTube-Cookies)). **Recomendação ao entrar: usar uma conta secundária.** O agente limita a taxa (um download por vez, com pausa entre eles).
- **Configuração:** "usar o login: **só quando o YouTube pedir** (padrão) ou **sempre**". Ambas exigem o login feito no início. "Sempre" aumenta o risco à conta.
- O Chrome/Edge recentes, no Windows, **criptografam os cookies de um jeito que o yt-dlp muitas vezes não consegue ler** (mesmo não sendo admin); o **Firefox** costuma funcionar. A alternativa é o usuário exportar um `cookies.txt`. O app deve **testar a leitura** na tela de login e dizer qual navegador funcionou.
- Abrir um Chromium com Playwright só para o login **não é necessário** e também esbarra nas proteções do Google contra automação: acrescenta ~150 MB sem ser mais confiável que ler o navegador que o usuário já tem.

**Regras fixas do agente**
- **Cookies nunca saem do computador**: o servidor não tem rota para recebê-los; o agente não os registra em log.
- **Validação no agente**: o `video_id` precisa casar com `^[A-Za-z0-9_-]{11}$`; o agente monta a URL canônica e **só aceita opções de uma lista fixa**. Um servidor comprometido não consegue mandar flags arbitrárias ao yt-dlp (execução de comando).
- Erros do YouTube continuam traduzidos (`errors.py`), com "Tentar de novo" só quando vale a pena.

### 8.1 Fontes sem YouTube: arquivo do usuário e fontes abertas (v2)

O pipeline só precisa de **um arquivo de áudio**; o download é apenas a primeira etapa. Por isso o job ganha um tipo de origem: `source: youtube | file | open_url`.

- **`file` (F32):** o dono escolhe o arquivo pelo **seletor de arquivos do sistema** no app (o servidor nunca indica um caminho). O agente **copia** o arquivo (não move) para a biblioteca, valida com `ffprobe` (formato de áudio, duração dentro do limite atual de 900 s, tamanho máximo, p. ex. 200 MB) e segue a partir da **separação de voz**, pulando o download. Formatos: mp3, flac, wav, m4a, ogg, opus.
- **Identificador:** hoje o id é o `video_id` do YouTube (11 caracteres). Arquivos usam `f-` + os primeiros 12 caracteres hexadecimais do **SHA-256 do conteúdo**, o que também **evita duplicar** o mesmo arquivo. A validação de id na API e no worker passa a aceitar os dois formatos (regex `^[A-Za-z0-9_-]{11}$` ou `^f-[0-9a-f]{12}$`), e o resto (`storage`, MP3, `lyrics.json`, `meta.json`) não muda.
- **Metadados:** `source.json` guarda título/artista lidos das etiquetas do arquivo (se houver); como hoje, **artista e nome são confirmados e obrigatórios** antes de buscar a letra.
- **`open_url` (F33):** o dono cola um link; o agente só aceita **hosts de uma lista fixa** (SoundCloud, Bandcamp, Internet Archive; outras depois), baixa com o yt-dlp **sem cookies** e segue o mesmo caminho do arquivo. O servidor nunca manda um host arbitrário ao agente (mesma regra da seção 8). Só funciona quando o autor permite download; o app mostra o erro do site quando não permite.
- **Quem importa:** na v2, **só o dono da sessão, pelo app**. O convidado não envia arquivo pelo celular (evita upload grande e arquivos de terceiros passando pela nuvem). O convidado continua pedindo músicas da biblioteca e do YouTube.
- **Direitos autorais:** o app não verifica a origem do arquivo; a responsabilidade é de quem importa (uso pessoal), o que deve constar no aviso de uso.
- **Testes:** unitário do pipeline a partir de um WAV curto sintético (sem rede), validação do id (`f-…`), rejeição de formato/tamanho/duração inválidos e de host fora da lista.

## 9. Interface do agente

Bandeja do sistema + janela simples: **Parear** (código de 8 caracteres, uma vez), **Iniciar sessão / Entrar com o YouTube** (escolher navegador e perfil, com o teste "Conectado"), **status** (conectado, processando, fila, salas da sessão), **pasta da biblioteca**, **hardware detectado** (GPU/CPU, botão "usar CPU"), **uso do login** (só quando o YouTube pedir, padrão / sempre), **logs**, **iniciar com o Windows**, **versão e atualização**. Sem telemetria.

## 10. Segurança

- Token de dispositivo longo, guardado no cofre do sistema; revogável; só vale para o seu dono. O servidor limita taxa e tamanho em todas as rotas do agente.
- TLS obrigatório; sem portas de entrada no computador do usuário.
- Upload (`PUT /library`): lista de nomes permitidos, limite de tamanho, bloqueio de `..`, escrita atômica.
- Nenhum segredo no instalador; o repositório continua **sem músicas** (`storage/` ignorado); o instalador é entregue por link privado e o motor é baixado das fontes oficiais, então nada disso vai para as Releases públicas.
- Modelo de ameaça principal: **servidor comprometido** (não pode executar código no agente: seção 8, item 4) e **agente de terceiros** (não lê jobs de outra biblioteca: token por dono).

## 11. Testes

- **Contrato do `JobBackend`:** a mesma suíte roda contra `RedisBackend` e `HttpBackend`.
- **Servidor:** testes das rotas `/agent/v1` (pareamento, claim com expiração, upload com limites e traversal) no padrão atual (`node:test`).
- **Ponta a ponta:** um **agente falso** no servidor de teste do Playwright (já existe fila de jobs em memória) valida pedir uma música, ver o progresso e tocar.
- **Instalador:** matriz em VMs Windows 10/11 sem GPU, com NVIDIA e sem Python/Docker instalados; teste de fallback para CPU quando a GPU falha.
- **Download:** teste agendado (não bloqueante) com um conjunto fixo de vídeos para detectar quebra do yt-dlp.

## 12. Marcos

| Marco | Entrega | Critério de pronto |
|---|---|---|
| **M0 ✅** | `JobBackend` + API `/agent/v1` + **sessões e roteamento de jobs por sessão** + agente falso nos testes | Fluxo completo passa com o worker atual trocado para HTTP; um job de uma sala só é reivindicado pelo agente da sessão dela |
| **M1 (M1a ✅, M1b ✅, M1c ✅)** | Agente "sem interface" (linha de comando) com motor via Docker/venv, **login do YouTube pelo navegador (`--cookies-from-browser`), servidor local de mídia e a origem `file`/`open_url` (comando `importar`)** | Baixa e processa a partir da nuvem num PC com IP residencial; o login é validado; o aviso de rede local do Chrome/Edge já foi **testado** (seção 5) e a música local toca na TV a partir do servidor local de mídia |
| **M2 ✅** | Pacote do motor (CPU e cu121) + sondagem de hardware | Instala sem Python/Docker; GPU testada com fallback |
| **M3 ✅** | Casca Electron: sessão, tela "Entrar com o YouTube", botão "Importar arquivo", bandeja, pasta da biblioteca, logs | Um leigo inicia a sessão, entra com o YouTube e processa uma música sem terminal |
| **M4** | Instalador **Windows** + auto-update | Instalação limpa em VM; atualização testada |
| **M5** | Modo híbrido ("Levar para a nuvem") (v2.1) | Música publicada toca em outro computador |
| **M6** | macOS/Linux, GPU AMD/Apple | v3 |

### 12.1 M0: o que foi feito e o que mudou do plano (Out/2026)

**Feito.** O worker fala com um `Backend` (`backend.py`): `RedisBackend` (o worker clássico, sem mudança de comportamento) e `HttpBackend` (o agente local, por HTTP de saída). A API ganhou `/agent/v1` (pareamento, dispositivos, sessões, salas da sessão, jobs, busca e exportação), o roteamento por sessão e o estado `owner` da sala. Testes novos: API (25 em memória e 11 com Redis de verdade, ligados na CI), worker (31) e ponta a ponta com um agente falso no Playwright (3). Verificado também com a API em Node, o Redis e o worker em Python por HTTP, do pareamento à música pronta, à busca e ao MP4 (14 de 14 verificações).

**Mudou ou ficou decidido no caminho**
- **Pareamento sem tela ainda:** o código é gerado pelo administrador (`ADMIN_TOKEN` + `POST /agent/v1/pair/start`) e o agente o troca por um token com `--pair`. A tela web para isso fica para o M3.
- **A sala diz de onde vem o pedido pelo cabeçalho `X-Room`** (busca, troca de letra e exportação não eram "da sala"). O front-end passa o código da sala; sem ele (ou numa sala sem sessão) vale o worker clássico.
- **O estado de um job continua por `video_id`** (um só `job:<id>` no Redis). Se dois donos pedem a mesma música ao mesmo tempo, o segundo espera o primeiro (dedupe). No M0 o armazenamento ainda é uma pasta compartilhada; bibliotecas por sessão virão com o armazenamento local (M1).
- **Pedido preso com um dono que sumiu:** se outro dono pede a mesma música e o primeiro está sem sinal, o pedido antigo é liberado (falha "o dono saiu") e a mensagem velha é descartada quando o dono antigo voltar. Com o dono online, o pedido continua com ele.
- **`claim` do mesmo agente devolve primeiro o que ficou com ele** (é assim que um agente que reiniciou retoma o job; a contagem de tentativas sobe). Por isso o agente só chama `claim` quando está ocioso. Um job sem sinal por 30 min vai para outro agente da mesma sessão.
- **Retomar a sessão (`resume_id`):** o agente que reinicia continua a mesma sessão (as salas e os pedidos seguem); sem isso, a sessão antiga é encerrada e os pedidos pendentes dela viram falha "o dono saiu".
- **O Fastify descarta campos extras do corpo** (não os rejeita); por isso o servidor só aceita uma lista fixa de campos em cada rota do agente.

**Fica para os próximos marcos:** o servidor local de mídia, o login do YouTube, a origem `file`/`open_url` (M1); a tela de pareamento e o aviso "o dono está desconectado" na interface (M3).

### 12.2 M1a: armazenamento local (Out/2026)

O M1 foi dividido em três partes: **M1a** (armazenamento local: servidor local de mídia e catálogo), **M1b** (download sem cookie primeiro e login do YouTube pelo navegador) e **M1c** (importar arquivos e fontes abertas). O M1a está pronto.

**Feito**
- **Agente:** `media_server.py` (servidor em `127.0.0.1`, com um token aleatório no caminho, só uma lista fixa de arquivos, CORS só para a origem da página, `Range`, `HEAD`/`OPTIONS`, `?download=` para baixar MP4) e `catalog.py` (o `meta.json` e quais arquivos existem). O `HttpBackend` envia o `media_base` ao iniciar a sessão e na batida de coração e publica o catálogo (`PUT /agent/v1/library`) ao iniciar, a cada música pronta, a cada análise de vozes de apoio e a cada MP4; uma falha de rede não derruba o job (a próxima batida tenta de novo).
- **API:** tabela `agent_songs` (o catálogo é **do dispositivo**, não da sessão: sobrevive a reinícios), `sessions.media_base` (só máquina local ou rede privada, `http`, sem credenciais nem consulta), e o serviço de músicas descreve a música, a biblioteca e os MP4 pelo catálogo do dono quando a sala tem armazenamento local. Os identificadores `f-<12 hex>` (arquivos importados) já são aceitos.
- **Front-end:** o estado da sala traz `local_media`; a TV verifica o acesso ao servidor local (o que também provoca o aviso do navegador) e orienta o usuário se for bloqueado; o celular não oferece a prévia do instrumental nas músicas locais; o download de MP4 de outra origem usa `?download=`.
- **Testes:** API (13 do catálogo), agente (19 do servidor de mídia e do catálogo e 8 da publicação, 147 no total do worker), front-end (4 unitários e 4 ponta a ponta no Chrome, com um servidor de mídia em outra origem). Verificado também entre linguagens (API com armazenamento vazio + Redis + agente): a sala fica pronta pelo catálogo, o navegador lê o áudio com CORS e `Range`, outro site recebe 403, a voz isolada 404, e depois de reiniciar o agente a música continua pronta com o endereço novo. Em Docker, com a biblioteca real, o Chrome tocou uma música na TV a partir do container.

**Decisões e aprendizados**
- **O catálogo é do dispositivo:** quem inicia uma sessão nova já encontra a biblioteca; só o endereço da mídia (e o token) muda a cada execução do agente.
- **O endereço de mídia é validado no servidor**, porque ele chega ao navegador de todos da sala: um agente comprometido não pode apontá-los para um site qualquer.
- **O token no caminho** protege contra outra página ou programa do mesmo computador; o CORS (só a origem da página) contra outros sites; a lista fixa de arquivos mantém a voz isolada e o `source.json` dentro do computador.
- **Docker é só para desenvolvimento:** o servidor de mídia escuta em `0.0.0.0` dentro do container (`AGENT_MEDIA_HOST`), a porta é publicada e o endereço que o navegador usa vem de `AGENT_MEDIA_PUBLIC`.
- **Limites:** a prévia do instrumental no celular não existe para músicas locais; o MP4 de uma música local só baixa no computador do dono (o celular não alcança o servidor local); Firefox e Safari não foram testados.

**Fica para o M1b e o M1c:** baixar sem cookie primeiro e o login do YouTube pelo navegador; o comando `importar` (arquivo e fontes abertas).

### 12.3 M1b: baixar sem cookie primeiro e o login do YouTube (Out/2026)

**Medido nesta máquina (Windows, Chrome 155 e Edge 155 instalados)**
- **`--cookies-from-browser` não serve como caminho principal:** com o Chrome aberto o banco de cookies fica bloqueado ("Could not copy Chrome cookie database") e com o Edge a leitura falha ("Failed to decrypt with DPAPI"), por causa da criptografia de cookies dos navegadores Chromium. O Firefox funcionaria, mas não estava instalado.
- **O protocolo de depuração entrega os cookies descriptografados:** abrindo o Chrome e o Edge com um perfil dedicado e uma porta de depuração, `Storage.getCookies` devolve os cookies da conta sem passar pela criptografia. É a base do login.
- **O pedido de validação:** a playlist "Assistir mais tarde" (`WL`) só existe para uma conta logada. Sem cookie o YouTube responde "The playlist does not exist"; com um cookie válido, devolve a playlist.
- **Sem cookie primeiro funciona pelo IP de casa:** 3 de 3 downloads reais na imagem do worker, com o `cookies.txt` disponível, não usaram a conta nenhuma vez.

**Feito**
- **Política de cookies** (`cookies.py`): `YTDLP_COOKIES_POLICY` = `when-asked` (padrão), `always` ou `never`. O download e a busca tentam sem cookie e, se o YouTube pedir login (confirmação de "não sou um robô", restrição de idade ou 403), repetem com a conta. Falhas que a conta não resolve (vídeo privado, removido, rede) sobem sem gastá-la. Um erro novo, `forbidden` (403), é repetido sozinho.
- **Fontes de cookies**, em ordem: `YTDLP_COOKIES` (arquivo), `YTDLP_COOKIES_BROWSER` (yt-dlp; serve ao Firefox) e o login do próprio agente.
- **Login pelo navegador** (`youtube_login.py`, `--youtube-login [chrome|edge]`): abre o Chrome ou o Edge instalado com um **perfil dedicado**, espera o login, lê os cookies pelo protocolo de depuração (cliente `websockets`), guarda só os do YouTube e do Google e fecha o navegador. `--youtube-status` valida com o pedido acima.
- **Testes:** 42 novos no worker (política, fontes, formato do `cookies.txt`, fluxo do login com navegador falso e com um servidor WebSocket de verdade). Verificado com o **Chrome e o Edge reais**: login detectado, só os cookies do YouTube/Google guardados, navegador fechado, perfil dedicado criado, validação com sessão inválida.

**Decisões e aprendizados**
- **O login não é pedido a cada download:** a conta fica **pronta** (login feito uma vez) e só entra quando o YouTube pede. É a decisão de reduzir o risco à conta.
- **O perfil é dedicado ao agente:** o perfil pessoal do usuário não é tocado, e fechar o navegador depois de exportar evita que o YouTube gire os cookies exportados.
- **Dois defeitos achados pelos testes:** o filtro de domínios aceitava nomes que só *terminam* igual (`notyoutube.com`, `evilgoogle.com`), o que guardaria o cookie de outro site; e a escolha do navegador não caía para o outro quando o preferido não existe. Os dois foram corrigidos.
- **Testado com uma conta Google de verdade (pelo dono, no Chrome 155, em Out/2026):** o Google **aceitou** o login na janela aberta com a porta de depuração, o agente guardou 48 cookies e a validação respondeu "Conectado". Se um dia o Google recusar esse login, a alternativa é o Firefox (`YTDLP_COOKIES_BROWSER=firefox`) ou um `cookies.txt` exportado de uma janela anônima. Não testado: o Edge com conta real e a vida útil dos cookies exportados (semanas?), que só o uso mostra.

### 12.4 M1c: importar arquivos e links de fontes abertas (Out/2026)

**Feito**
- **`--import ARQUIVO --artist A --title T`** (`importer.py`): aceita mp3, flac, wav, m4a, ogg e opus; valida com ffprobe/ffmpeg (texto disfarçado de mp3 é recusado), limites `IMPORT_MAX_MB` (200) e 900 s. O id é `f-` + 12 hex do SHA-256 do áudio: o mesmo conteúdo com outro nome é a mesma música e reimportar é instantâneo. Artista/título vêm das etiquetas ou das opções.
- **`--import-url LINK`**: só SoundCloud, Bandcamp e Internet Archive (domínio exato ou subdomínio), sem cookies, só faixas avulsas (playlists, álbuns e buscas ficam de fora). Link do YouTube é recusado antes de qualquer download.
- Com `AGENT_URL`/`AGENT_TOKEN`, a música é publicada no catálogo do agente e aparece na biblioteca da sala. A API nunca cria job do YouTube para um id `f-` (`song_not_found`), e a letra de uma importada muda reimportando (409 `imported_lyrics`).
- **Testes:** 38+ novos no worker, 2 na API; execução entre linguagens 18/18 (importar pela CLI, catálogo, convidado põe na fila, servidor local de mídia serve, id `f-` desconhecido recusado, nenhum job criado).

**Medido e lições**
- Validação real na imagem do worker: 6 formatos lidos pelo ffprobe de verdade, importação real com Demucs em 20 a 31 s para um trecho de 12 s, um item real do Internet Archive importado.
- O `allowed_extractors` do yt-dlp casa com o **IE_NAME** do extrator (`archive.org`, `Bandcamp`), não com a chave; a primeira versão falhou num link real e um teste de contrato contra a lista do próprio yt-dlp agora protege isso.
- O `check_disk` quebrava quando a pasta da biblioteca ainda não existia (instalação nova); agora mede a pasta existente mais próxima.
- Os originais importados não são copiados para a biblioteca, só os derivados. O botão "Importar arquivo" fica para o M3.

### 12.5 M2: aviso de versão, verificação do hardware e pacote do motor (Out/2026)

**Feito**
- **Versão e aviso de atualização:** um número só (`singalong_worker/version.py`). O `GET /agent/v1/version?current=X` (aberto, usável antes de parear) e o campo `update` da resposta do `/heartbeat` dizem `ok`, `update_available` ou `update_required`, com a versão mais recente e a mínima, uma nota e o link de download; o servidor lê tudo de `APP_LATEST_VERSION`, `APP_MIN_VERSION`, `APP_NOTES` e `APP_DOWNLOAD_URL`. Abaixo da mínima, o servidor responde `426` aos jobs; o agente trata como falha passageira (espera e registra no log) e volta a trabalhar sozinho depois da atualização. Linha de comando: `--version`, `--check-update`.
- **Verificação do hardware** (`hardware.py`, só biblioteca padrão): `--hardware` lê o `nvidia-smi` (nome, driver, memória, capacidade de computação) e recomenda `cu121` ou `cpu` com o motivo: driver abaixo de 527.41, placa sem kernels no torch 2.5.1/cu121 (Kepler, **Blackwell/RTX 50**) ou com menos de 3 GB de memória vão para a CPU. `--hardware --selftest` roda uma convolução pequena na GPU. O resumo (motor, núcleos, RAM, placa) vai no heartbeat.
- **Pacote do motor** (`apps/engine`, Node sem dependências, para ser chamado pela interface Electron): o `manifest.json` fixa o Python 3.11 (python-build-standalone), o ffmpeg 8.1 **GPL** (BtbN) e o deno, cada um com a URL oficial e o **SHA-256**; o torch 2.5.1 e os demais pacotes vêm do pip (índice do PyTorch `cpu` ou `cu121`). O `assemble` baixa com retomada e hash obrigatório, extrai com o `tar.exe` do próprio Windows, copia o worker, pergunta à verificação qual motor usar, instala, roda o teste da GPU e, se falhar, **troca só o torch pela versão de CPU** e registra o motivo. Cada etapa concluída fica no `engine.json`: app fechado ou conexão caída continua de onde parou; um manifesto novo refaz só o que mudou. O `verify` confere ffmpeg (GPL, `libx264`, `aac`, `libmp3lame`, `rubberband`, `subtitles`), ffprobe, deno e os imports do Python. O worker roda com `launchEnv`: o ffmpeg e o deno do motor entram no PATH **só daquele processo**.
- **Testes:** 27 no worker (versão, hardware com `nvidia-smi` e torch falsos), 5 na API, 19 no motor (download contra um servidor HTTP de verdade: retomada, queda, hash errado, 404; montagem com dublês: ordem, escolha CPU/GPU, volta para a CPU, retomada, download adulterado), que também rodam num runner Windows na CI.

**Medido nesta máquina (Windows 11, RTX 3060, driver 617.42; a partir de uma pasta vazia, sem Docker nem Python do sistema)**
- A verificação escolheu `cu121`; o teste real da GPU passou. O mesmo teste dentro da imagem Docker passou com a GPU e falhou de forma limpa ("o torch não enxerga uma GPU CUDA") sem ela.
- O motor `cu121` ocupa **5,6 GB** (mais ~0,26 GB de downloads em cache que podem ser apagados); as 7 verificações do `verify` passaram.
- Uma música de verdade passou só pelo pacote (importar, Demucs na GPU, melodia, tom): 1 min 18 s na primeira vez, incluindo baixar os pesos do Demucs.

**Defeitos encontrados rodando de verdade**
- Um `tar` do Git/MSYS no PATH lê `D:\pasta` como máquina remota: o motor agora chama o `System32\tar.exe` do Windows.
- O nome do arquivo do componente chegava codificado (`%2B`) e precisou ser decodificado.
- As mensagens de conflito do pip sobre o `audio-separator` (instalado com `--no-deps` de propósito) também aparecem aqui e são inofensivas.

**Decisões**
- **O yt-dlp vem do pip, não como `.exe`**: o worker o usa como biblioteca e atualizá-lo é um `pip install -U` na abertura. Não há binário separado do yt-dlp no pacote.
- **O ffmpeg está fixado numa versão datada da BtbN.** A BtbN apaga versões antigas depois de um tempo: se a URL parar de funcionar, o `manifest.json` recebe uma URL e um SHA-256 mais novos (o teste confere só o formato, não a rede). A alternativa é hospedarmos esse arquivo.
- Os pacotes do pip são fixados por versão, não por hash; travar com hashes pode vir com o instalador (M4).
- As placas Blackwell (RTX 50) usam a CPU até o motor passar para um torch/CUDA mais novo.

**Fica para o M3/M4:** a interface que chama o `assemble` com barra de progresso e a tela "atualização disponível"; o instalador; o teste numa VM limpa.

### 12.6 M3: o app do dono, interface Electron (Out/2026)

**Feito** (`apps/desktop`)
- **Controlador sem Electron** (`src/controller.js`): guarda a configuração (`config.json` na pasta de dados do usuário), monta o motor (chama o `apps/engine` e mostra o progresso), pareia (`/pair/complete`), inicia e para o **agente** (o worker em modo serviço, como processo filho, reiniciado se cair e não reiniciado se o servidor recusar o token), consulta o `/me` para saber quando a sessão está online e roda os comandos do worker: criar sala, login/conferência do YouTube, importar arquivo, hardware. A janela nunca recebe o token.
- **Janela** (`ui/`, HTML/JS simples, CSP restrita, nenhum HTML montado com texto de fora): **preparar o computador** (escolha placa de vídeo ou processador, barra de progresso, tentar de novo), **conectar ao servidor** (endereço, código, nome do computador) e então o **início**: o aviso de atualização (com a nota e o link), a sessão (apelido que os convidados veem, iniciar/encerrar), salas (criar; "Abrir a TV" e "Abrir como anfitrião" no navegador), **"Importar arquivo…"**, YouTube (estado e login, escolha do navegador), configurações (abrir com o Windows, hardware, desparear) e o registro.
- **Casca** (`src/main.js`, `preload.cjs`): isolamento de contexto e sandbox ligados; a janela só recebe uma lista fixa de ações; o navegador só abre endereços do servidor pareado ou do link de atualização; ícone na bandeja (fechar a janela com a sessão rodando só esconde; "Sair" encerra a sessão antes); uma instância só.
- **Testes:** 19 do controlador (servidor de mentira e worker de mentira como processos de verdade: pareamento, motor, reinício do agente, sala, YouTube, importar, desparear, token nunca no estado) e **1 de ponta a ponta com a pilha real**: Electron + a API de verdade + o worker de verdade (pareamento com código errado e depois certo, aviso de atualização, apelido, sessão online, sala vista pelo servidor como "Dona Flor", arquivo que não é áudio recusado com mensagem legível, hardware, fim da sessão). Na CI os testes do controlador rodam em Linux e Windows e o da janela no Windows.

**Defeitos achados pelo teste de ponta a ponta**
- O controlador mandava `content-type: application/json` num `DELETE` sem corpo e o Fastify recusava: **a sessão nunca era encerrada no servidor** (o teste unitário anterior usava um servidor de mentira que aceitava). Corrigido (o cabeçalho só vai quando há corpo).
- Encerrar a sessão antes de matar o processo deixava o sinal de vida do worker abrir **outra** sessão; a ordem agora é: anotar a sessão, parar o processo, encerrar a sessão.
- `ELECTRON_RUN_AS_NODE=1` (exportado pelo VS Code) faz o Electron rodar como Node puro; o teste remove isso. O modo "electron" do próprio Playwright não lida com `main` em ESM, então o teste da janela inicia o Electron direto e o controla pelo protocolo de depuração.

**Decisões e o que falta**
- O token fica no `config.json` da pasta do perfil do usuário (privada à conta do Windows); protegê-lo com a criptografia do sistema (`safeStorage`) pode vir com o instalador.
- A pasta da biblioteca é fixa (`<dados>/library`) por enquanto; escolher outra pasta fica para depois.
- O código de pareamento ainda é gerado pelo administrador do servidor (`ADMIN_TOKEN`); um jeito mais amigável de parear sem pedir código fica para a v2.
- Não testado numa máquina limpa: isso é do M4.

## 13. Decisões tomadas e perguntas em aberto

**Decidido (Out/2026)**
1. A conta de download é **uma por sessão**, pedida no início, e vale para todas as salas da sessão (seções 3.1 e 8).
2. Armazenamento **local primeiro** (modo A); híbrido depois (M5).
3. Primeira plataforma: **só Windows**.
4. O download usa o login **só quando o YouTube bloquear** (sem cookie primeiro); "sempre" é uma opção.
5. O **ffmpeg (build GPL)** vai dentro do pacote do motor (seção 7).
6. **Importar arquivos do usuário e links de fontes abertas entra na v2** (seção 8.1).
7. **Só o dono da sessão importa arquivos**, pelo app; o convidado não envia arquivo pelo celular.
8. O app **não verifica a origem** de um arquivo importado: a responsabilidade é de quem importa (uso pessoal), e isso consta no aviso de uso.
9. Os convidados veem só um **apelido** escolhido pelo dono no início da sessão, nunca a conta do YouTube.
10. **A TV roda no computador do dono** (onde ficam os microfones). O celular: entrar em salas, escolher músicas, mudar o tom da música escolhida, passar a vez e ajustar a voz de apoio; **sem prévia do instrumental no celular** na v2.
11. O instalador **não será distribuído publicamente** (só para o dono e pessoas próximas) e **não será assinado**.
12. O instalador se chama **`singalong_karaoke.exe`** e, **por ora, não é publicado nem hospedado** (fica só na máquina do dono).
13. O **pacote do motor é montado no computador do usuário**, a partir das fontes oficiais, com versões e checksums fixados (seção 7).

**Em aberto**
1. **Firefox e Safari** com a TV no computador do dono: não testados (o aviso de rede local do Chrome e do Edge foi testado e funciona; seção 5). A v2 mira Chrome/Edge.

**Sem meios de teste no momento:** RTX 50 (Blackwell) e GPUs de outros fabricantes. O torch atual (2.5.1/cu121) provavelmente não tem suporte à RTX 50; o instalador testa a GPU e cai para a CPU, mas isso **não foi validado** nessas placas. Subir a versão do torch obrigaria a revisar o Demucs, hoje fixado em 2.5.1.
