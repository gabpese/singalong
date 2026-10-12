# Singalong — Documento de Requisitos do Produto (PRD)

[English](PRD.md) · **Português (Brasil)**

Versão 0.1 · Out/2026 · Dono do produto: Gabriel Pesegoginski · Documento técnico correspondente: [TRD.pt-BR.md](TRD.pt-BR.md)

## 1. Visão

Um karaokê **próprio e colaborativo**: qualquer música do YouTube vira, em minutos, uma versão karaokê (instrumental, letra sincronizada palavra a palavra, troca de tom, vozes de apoio, pontuação pelo microfone), com uma **fila compartilhada pelo celular** de todo mundo e a **TV como player**. Sem assinatura, sem catálogo fechado, sem anúncios.

## 2. Problema

- Apps de karaokê têm catálogo fechado e pago; a música que o grupo quer quase nunca está lá.
- Fazer o instrumental e a letra sincronizada à mão é trabalhoso.
- Numa festa, uma pessoa só controla o computador e a fila vira confusão (quem canta quando? quem monopoliza?).
- Cantar fora do tom da própria voz é ruim; trocar o tom exige reprocessar a música.

## 3. Quem usa (personas)

| Persona | O que quer | Onde usa |
|---|---|---|
| **Anfitrião** | Montar a festa, controlar a fila, deixar tudo justo | Celular + computador na TV |
| **Cantor/convidado** | Escolher a música, ajustar o tom à sua voz, ver quando cantar | Celular (entra pelo QR code) |
| **Dono da biblioteca** | Ter as músicas processadas e disponíveis em qualquer lugar, sem custo | Casa e casas de amigos |
| **Instalador futuro (usuário comum)** | Instalar e usar sem saber de Docker, Python ou linha de comando | Windows primeiro |

## 4. Objetivos e não objetivos

**Objetivos**
1. Transformar um link/busca do YouTube em karaokê com o mínimo de passos.
2. Fila justa e colaborativa, com a próxima música sempre pré-processada.
3. Funcionar **de qualquer computador, sem o PC do dono ligado**, para as músicas já prontas (hospedagem gratuita; é o que a v1 faz). Na v2 com armazenamento local, o PC do dono precisa estar ligado até existir o modo híbrido.
4. Poder **instalar sem conhecimento técnico** e processar músicas novas no computador do usuário (agente local), numa **sessão com uma conta do YouTube** escolhida no início.
5. **Custo zero** de operação para o dono (só recursos gratuitos).

**Não objetivos (por enquanto)**
- Vídeo de fundo, catálogo comercial, contas pagas, app nativo de celular, multi-idioma de interface (a interface é em português do Brasil).
- Hospedar músicas de terceiros como serviço público (ver riscos legais, seção 9).

## 5. Requisitos funcionais

Estados: ✅ pronto · 🔧 planejado · 💡 ideia.

### 5.1 Salas e fila
| ID | Requisito | Estado |
|---|---|---|
| F1 | Criar sala com código e QR code; a TV abre como player e os celulares entram pelo QR | ✅ |
| F2 | Fila por sala com adicionar, remover, reordenar, pular, pausar/retomar e arrastar a posição (anfitrião) | ✅ |
| F3 | Rodízio justo opcional (a mesma pessoa não canta duas seguidas) e "ceder a vez" | ✅ |
| F4 | Link de anfitrião para controlar a sala de outro aparelho | ✅ |
| F5 | Próxima música sempre pré-processada; se não estiver pronta, toca a seguinte pronta e a atrasada mantém o lugar | ✅ |

### 5.2 Adicionar músicas
| ID | Requisito | Estado |
|---|---|---|
| F6 | Buscar no YouTube por artista, nome ou ambos, com prévia do vídeo; ou colar o link | ✅ |
| F7 | Letra: legenda manual do vídeo, LRCLIB, texto colado (alinhado por IA), `.lrc/.srt` ou **sem letra** | ✅ |
| F8 | Jukebox: sugerir versões já prontas antes de buscar no YouTube | ✅ |
| F9 | Biblioteca com filtro por artista e nome, ordenada alfabeticamente | ✅ |
| F10 | Processar músicas novas **sem o PC do dono ligado e sem o YouTube bloquear** (agente local) | 🔧 |

### 5.3 Reprodução
| ID | Requisito | Estado |
|---|---|---|
| F11 | Letra sincronizada com preenchimento palavra a palavra e aviso de pausa (intro/solo) | ✅ |
| F12 | Troca de tom de −6 a +6 semitons por música, ao vivo, só no instrumental | ✅ |
| F13 | Tom da música detectado e mostrado como nota | ✅ |
| F14 | Nível das vozes de apoio (0–100%) por música | ✅ |
| F15 | Ajuste de letra (offset) pelo anfitrião | ✅ |
| F16 | Prévia no celular do instrumental com o tom escolhido | ✅ |

### 5.4 Pontuação e exportação
| ID | Requisito | Estado |
|---|---|---|
| F17 | Pontuação por afinação do microfone, ligada pelo anfitrião, com placar | ✅ |
| F18 | Exportar MP4 de karaokê (com escolha de tom) para cantar offline | ✅ |

### 5.5 Hospedagem e instalação
| ID | Requisito | Estado |
|---|---|---|
| F19 | Hospedagem gratuita com HTTPS (Oracle Always Free + Caddy + DuckDNS) | ✅ |
| F20 | CI/CD no GitHub Actions com imagem multi-arquitetura | ✅ |
| F21 | **Instalador** para Windows que instala o agente local (download, separação de voz, alinhamento) sem Docker | 🔧 |
| F22 | O instalador detecta a placa de vídeo e usa a GPU NVIDIA quando possível; senão, usa a CPU | 🔧 |
| F23 | Atualização automática do agente e do yt-dlp | 🔧 |
| F24 | **Armazenamento local**: as músicas ficam numa pasta do computador do usuário e o player lê direto dela | 🔧 |
| F25 | Escolher, por música, se ela também vai para a nuvem (**modo híbrido**, planejado depois do local) | 💡 |
| F26 | Versões para macOS e Linux; GPU AMD/Apple | 💡 |

### 5.6 Sessão e conta do YouTube (decidido)
| ID | Requisito | Estado |
|---|---|---|
| F27 | O usuário **inicia uma sessão** no software e **entra com o YouTube logo no início**; a sessão tem **uma única conta**, escolhida por ele | 🔧 |
| F28 | Todas as salas criadas na sessão usam **essa mesma conta** para baixar. Quando alguém pede uma música pelo celular, **quem baixa é o dono da sessão** a que aquele celular está conectado, com o padrão definido | 🔧 |
| F29 | O login é pedido **antes** de qualquer download (não se tenta, falha e só então se pede), e o app mostra se a conta está conectada | 🔧 |
| F30 | Os cookies da conta **ficam só no computador do dono**, nunca vão para a nuvem nem para os convidados | 🔧 |
| F31 | Se o dono da sessão está offline, a sala avisa "o dono da sessão está desconectado" e o pedido espera na fila | 🔧 |

## 6. Requisitos não funcionais

| Área | Requisito |
|---|---|
| **Custo** | Operar a nuvem usando só recursos gratuitos; nada que possa gerar cobrança automática |
| **Desempenho** | Letra e áudio sem dessincronizar (relógio local do player); trocar o tom sem corte perceptível; com GPU NVIDIA, separar uma música de 4 min em segundos (medido: ~8 s numa RTX 3060) |
| **Compatibilidade de hardware** | Funcionar em qualquer PC com Windows 10/11 de 64 bits; GPU é aceleração opcional, nunca requisito |
| **Segurança e privacidade** | Cookies e músicas só no computador do usuário (salvo escolha explícita); servidor sem login de terceiros; tokens revogáveis; sem telemetria por padrão |
| **Segurança de contexto** | HTTPS obrigatório na nuvem (troca de tom e microfone exigem contexto seguro) |
| **Robustez** | Falhas do YouTube viram mensagens claras; retentativas só para falhas passageiras; job que derruba o worker não entra em loop |
| **Instalação** | Instalar e começar a usar em até 15 minutos, sem terminal; o download grande (motor de IA) acontece com barra de progresso |
| **Manutenção** | O yt-dlp quebra com frequência: atualização automática e erro recuperável |

## 7. Métricas de sucesso

- Tempo entre pedir uma música nova e ela tocar (meta com GPU: < 2 min; com CPU: < 10 min — a validar).
- Taxa de downloads bem-sucedidos pelo agente local (meta: > 95% sem cookie em IP residencial — a validar).
- Instalações concluídas sem ajuda (meta: > 90% em teste com 5 pessoas).
- Custo mensal da nuvem: US$ 0,00.

## 8. Escopo das versões

- **v1 (feito):** tudo de F1 a F20, rodando com Docker no PC do dono e/ou na VM gratuita (só a biblioteca copiada).
- **v2 (próxima):** agente local + instalador **só para Windows**, com sessão e conta do YouTube e **armazenamento local** (F10, F21 a F24, F27 a F31), com a nuvem como servidor central (salas, fila, celulares).
- **v2.1:** modo híbrido, "levar para a nuvem" por música (F25).
- **v3:** macOS/Linux, GPU AMD/Apple (F26).

## 9. Riscos e restrições

- **Direitos autorais e termos do YouTube.** Baixar e separar música protegida pode violar os termos do YouTube e direitos autorais. O projeto é para uso pessoal e privado. Distribuir um instalador para terceiros que baixa do YouTube aumenta a exposição do projeto: decidir antes de divulgar (ver perguntas em aberto).
- **O YouTube bloqueia IPs de datacenter** e muda com frequência; por isso o download acontece no computador do usuário.
- **Risco para a conta do YouTube.** O próprio yt-dlp avisa que usar uma conta com ele pode levá-la a ser restringida ou banida, e há relatos de bloqueio de IP ligado ao uso de cookies. Como a sessão baixa **sempre com a conta escolhida**, o uso de uma **conta secundária, só para isso**, deve ser a recomendação padrão ao entrar.
- **O login não pode ser feito numa janela embutida do app.** O Google bloqueia o login em navegadores embutidos (Electron e similares: "Este navegador ou app pode não ser seguro"). O login acontece no **navegador normal** do usuário, e o app lê dele a sessão. Os cookies do YouTube giram com frequência; o app precisa detectar a sessão vencida e pedir o login de novo.
- **Hardware variado:** placas muito novas ou de outros fabricantes podem não ter aceleração; o fallback para CPU é obrigatório.
- **Assinatura de código:** sem certificado, o Windows mostra aviso de "app desconhecido"; certificados pagos vão contra a regra de custo zero.
- **Armazenamento:** a biblioteca local cresce (medido: ~16 MB por música no PC, com a voz isolada; ~7 MB na nuvem, sem ela); o motor de IA ocupa alguns GB.

## 10. Perguntas em aberto

**Decidido (Out/2026):** a conta de download é **uma por sessão**, pedida no início, e vale para todas as salas da sessão; o armazenamento é **local primeiro** (híbrido depois); a primeira versão é **só para Windows**.

1. **O que a sessão mostra aos convidados?** O nome da conta do YouTube ou só um apelido escolhido pelo dono? (mostrar a conta real expõe a identidade dele)
2. **Uso do login:** em **todo** download (como decidido) ou, opcionalmente, **só quando o YouTube pedir**, para reduzir o risco à conta? Proposta: padrão "sempre", com a opção disponível.
3. **Como o convidado toca a música local?** Com armazenamento local, a **TV tem de rodar no computador do dono** (ou ligada a ele por HDMI); a prévia do instrumental no celular não funciona nesse modo. Isso é aceitável para a v2?
4. **Vai ser distribuído publicamente?** Muda a postura sobre direitos autorais, o aviso sobre a conta e o tipo de assinatura de código.
5. **Nome e identidade** do instalador e do agente.
