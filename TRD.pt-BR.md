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
- **O que a nuvem sabe da conta:** só um **apelido de exibição** e se a sessão está "conectada". Nunca cookies, e-mail ou senha.
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
| `POST /heartbeat` | Versão do agente, hardware detectado, fila local; a página web mostra "agente conectado" |
| `DELETE /devices/:id` | O dono revoga um dispositivo |

No agente, a mudança de código é pequena: `runner.process` já é independente do cliente Redis. Cria-se uma interface `JobBackend` com duas implementações (`RedisBackend`, a atual, e `HttpBackend`, nova). O Redis continua existindo no servidor e no modo Docker de desenvolvimento.

## 5. Armazenamento: onde ficam os arquivos (decidido: local primeiro; híbrido depois)

**Decisão (Out/2026):** a v2 usa o **modo A, só local**; o modo C (híbrido) é planejado depois (v2.1). A tabela abaixo mostra as três opções e por que a ordem.

A ideia de guardar tudo no computador do usuário e o player ler o arquivo local tem uma limitação de navegador:

- A página do karaokê vem de **`https://singalong…`**. Um navegador **bloqueia** que ela carregue áudio de `http://192.168.x.x` (conteúdo misto e acesso a rede privada). A exceção é `http://localhost`.
- Logo, a música **local** só toca na **TV que roda no próprio computador do agente** (ou ligada a ele por HDMI). A TV de outra casa ou de outro computador **não alcança** o arquivo.
- **Chrome pede permissão.** O Chrome tem a permissão de "Acesso à rede local" (*Local Network Access*): uma página pública que acessa `localhost` ou a rede local pode gerar um aviso para o usuário aceitar ([fonte](https://developer.chrome.com/blog/local-network-access)). Faltam detalhes confirmados (versão em que virou padrão, WebSocket e iframes): **testar no M1** e, se atrapalhar, servir a página da TV pelo próprio agente em `http://localhost`.
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

- **Instalador** (Windows, NSIS ou MSI via `electron-builder`): pequeno (~100 MB), instala por usuário (sem administrador) em `%LOCALAPPDATA%`.
- **Pacote do motor** (baixado na 1ª execução, com barra de progresso, retomável, com **checksum SHA-256**): Python embutido (python-build-standalone) + torch (cpu **ou** cu121) + dependências + `ffmpeg` + `yt-dlp` + `deno` (exigido pelo yt-dlp para resolver os desafios do YouTube). Hospedado nas **GitHub Releases** (gratuito).
- **Atualização:** o agente (auto-update) e o **yt-dlp** (verificado a cada início; é o que mais quebra) atualizam sozinhos, com versão mínima exigida pelo servidor (`/heartbeat` responde "atualize").
- **Assinatura de código:** sem certificado, o Windows (SmartScreen) avisa. Caminhos gratuitos: SignPath Foundation (projetos open source) ou aceitar o aviso no começo. Certificado pago contraria a regra de custo zero.
- **Licenças:** yt-dlp (Unlicense), ffmpeg (usar build LGPL, sem GPL), Demucs (MIT), pesos de modelos com licenças próprias: **revisar uma a uma** antes de redistribuir.

## 8. Download do YouTube e login da sessão

**Decisão (Out/2026):** o login do YouTube é pedido **no início da sessão**, antes de qualquer download, para nunca tentar, falhar e só então pedir. A conta escolhida baixa para **todas** as salas da sessão (seção 3.1).

**Fluxo de login ("Entrar com o YouTube")**
1. O app abre o **navegador padrão** do usuário na página de login do YouTube. **Não pode ser uma janela embutida do app:** o Google **bloqueia o login em navegadores embutidos**, como o Electron ("This browser or app may not be secure"; [política do Google](https://www.bleepingcomputer.com/news/security/google-to-block-logins-from-embedded-browser-frameworks), [guia sobre Electron](https://www.todesktop.com/docs/application/google-oauth-screen)).
2. O usuário entra (ou já está logado) e, no app, **escolhe o navegador e o perfil** onde fez isso.
3. O agente usa o recurso nativo do yt-dlp **`--cookies-from-browser`** para ler a sessão desse navegador. O OAuth do Google **não serve**: ele dá um token de API, não o cookie de sessão que o yt-dlp usa.
4. **Validação:** o app faz um pedido que só funciona logado (a definir e testar no M1) e mostra "Conectado" ou pede para tentar de novo. Só então a sessão pode baixar.
5. **Sessão vencida:** os cookies do YouTube giram com frequência (sobretudo com abas do YouTube abertas). O agente valida antes de cada job e, se venceu, avisa o dono ("entre de novo") e o job espera. Uma forma citada na wiki do yt-dlp é exportar os cookies de uma **janela anônima** que nunca mais é aberta.

**Cuidados e limitações**
- **Risco à conta.** O yt-dlp avisa que usar uma conta com ele pode levá-la a ser restringida ou banida, e recomenda pouca taxa de pedidos e, se possível, uma conta descartável ([wiki do yt-dlp](https://lab.trianta.dev/mirrors/yt-dlp.yt-dlp/wiki/Extractors)); há também relatos de bloqueio de IP ligado a cookies ([Pinchflat](https://github.com/kieraneglin/pinchflat/wiki/YouTube-Cookies)). **Recomendação ao entrar: usar uma conta secundária.** O agente limita a taxa (um download por vez, com pausa entre eles).
- **Opção de reduzir o risco:** nas configurações, "usar o login: **sempre** (padrão, como decidido) ou **só quando o YouTube pedir**" (sem cookie primeiro, pela internet residencial, e com cookie só no erro de login). Ambas exigem o login feito no início.
- O Chrome/Edge recentes, no Windows, **criptografam os cookies de um jeito que o yt-dlp muitas vezes não consegue ler** (mesmo não sendo admin); o **Firefox** costuma funcionar. A alternativa é o usuário exportar um `cookies.txt`. O app deve **testar a leitura** na tela de login e dizer qual navegador funcionou.
- Abrir um Chromium com Playwright só para o login **não é necessário** e também esbarra nas proteções do Google contra automação: acrescenta ~150 MB sem ser mais confiável que ler o navegador que o usuário já tem.

**Regras fixas do agente**
- **Cookies nunca saem do computador**: o servidor não tem rota para recebê-los; o agente não os registra em log.
- **Validação no agente**: o `video_id` precisa casar com `^[A-Za-z0-9_-]{11}$`; o agente monta a URL canônica e **só aceita opções de uma lista fixa**. Um servidor comprometido não consegue mandar flags arbitrárias ao yt-dlp (execução de comando).
- Erros do YouTube continuam traduzidos (`errors.py`), com "Tentar de novo" só quando vale a pena.

## 9. Interface do agente

Bandeja do sistema + janela simples: **Parear** (código de 8 caracteres, uma vez), **Iniciar sessão / Entrar com o YouTube** (escolher navegador e perfil, com o teste "Conectado"), **status** (conectado, processando, fila, salas da sessão), **pasta da biblioteca**, **hardware detectado** (GPU/CPU, botão "usar CPU"), **uso do login** (sempre / só quando o YouTube pedir), **logs**, **iniciar com o Windows**, **versão e atualização**. Sem telemetria.

## 10. Segurança

- Token de dispositivo longo, guardado no cofre do sistema; revogável; só vale para o seu dono. O servidor limita taxa e tamanho em todas as rotas do agente.
- TLS obrigatório; sem portas de entrada no computador do usuário.
- Upload (`PUT /library`): lista de nomes permitidos, limite de tamanho, bloqueio de `..`, escrita atômica.
- Nenhum segredo no instalador; o repositório continua **sem músicas** (`storage/` ignorado); o motor e o instalador só vão para as Releases.
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
| **M0** | `JobBackend` + API `/agent/v1` + **sessões e roteamento de jobs por sessão** + agente falso nos testes | Fluxo completo passa com o worker atual trocado para HTTP; um job de uma sala só é reivindicado pelo agente da sessão dela |
| **M1** | Agente "sem interface" (linha de comando) com motor via Docker/venv, **login do YouTube pelo navegador (`--cookies-from-browser`) e servidor local de mídia** | Baixa e processa a partir da nuvem num PC com IP residencial; o login é validado; **testado** o aviso de rede local do Chrome com a TV em `localhost` |
| **M2** | Pacote do motor (CPU e cu121) + sondagem de hardware | Instala sem Python/Docker; GPU testada com fallback |
| **M3** | Casca Electron: sessão, tela "Entrar com o YouTube", bandeja, pasta da biblioteca, logs | Um leigo inicia a sessão, entra com o YouTube e processa uma música sem terminal |
| **M4** | Instalador **Windows** + auto-update | Instalação limpa em VM; atualização testada |
| **M5** | Modo híbrido ("Levar para a nuvem") (v2.1) | Música publicada toca em outro computador |
| **M6** | macOS/Linux, GPU AMD/Apple | v3 |

## 13. Decisões tomadas e perguntas em aberto

**Decidido (Out/2026)**
1. A conta de download é **uma por sessão**, pedida no início, e vale para todas as salas da sessão (seções 3.1 e 8).
2. Armazenamento **local primeiro** (modo A); híbrido depois (M5).
3. Primeira plataforma: **só Windows**.

**Em aberto**
1. **Apelido ou conta real** exibido aos convidados (mostrar a conta real expõe a identidade do dono).
2. **Uso do login:** padrão "sempre" com a opção "só quando o YouTube pedir"; confirmar.
3. **TV no computador do dono** (e sem prévia do instrumental no celular) é aceitável na v2? A verificação do aviso de rede local do Chrome (M1) pode obrigar a servir a página da TV pelo agente.
4. **Distribuição pública?** Define a postura sobre direitos autorais, o aviso sobre a conta e a assinatura de código.
5. **RTX 50 e outras:** confirmar com a sua máquina e uma placa nova se o torch atual funciona (ou subir a versão do torch, o que obriga a revisar o Demucs, hoje fixado em 2.5.1).
