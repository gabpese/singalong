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
3. Funcionar **de qualquer computador, sem o PC do dono ligado**, para as músicas já prontas (hospedagem gratuita).
4. Poder **instalar sem conhecimento técnico** e processar músicas novas no computador do usuário (agente local).
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
| F23 | Pareamento do agente com o servidor por código, sem digitar senha nem editar arquivos | 🔧 |
| F24 | O YouTube é acessado pela internet do próprio usuário, **sem cookie por padrão**; cookie do navegador dele só como reserva, e nunca sai do computador | 🔧 |
| F25 | Atualização automática do agente e do yt-dlp | 🔧 |
| F26 | Escolher, por música, se ela fica só no computador do usuário ou vai também para a nuvem | 🔧 |
| F27 | Versões para macOS e Linux; GPU AMD/Apple | 💡 |

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
- **v2 (próxima):** agente local + instalador para Windows (F10, F21 a F26), com a nuvem como servidor central.
- **v3:** macOS/Linux, GPU AMD/Apple, contas e várias bibliotecas (F27).

## 9. Riscos e restrições

- **Direitos autorais e termos do YouTube.** Baixar e separar música protegida pode violar os termos do YouTube e direitos autorais. O projeto é para uso pessoal e privado. Distribuir um instalador para terceiros que baixa do YouTube aumenta a exposição do projeto: decidir antes de divulgar (ver perguntas em aberto).
- **O YouTube bloqueia IPs de datacenter** e muda com frequência; por isso o download acontece no computador do usuário.
- **Hardware variado:** placas muito novas ou de outros fabricantes podem não ter aceleração; o fallback para CPU é obrigatório.
- **Assinatura de código:** sem certificado, o Windows mostra aviso de "app desconhecido"; certificados pagos vão contra a regra de custo zero.
- **Armazenamento:** a biblioteca local cresce (medido: ~16 MB por música no PC, com a voz isolada; ~7 MB na nuvem, sem ela); o motor de IA ocupa alguns GB.

## 10. Perguntas em aberto

1. **Quem é o dono de uma biblioteca?** Um único dono por servidor (o servidor é pessoal) ou várias pessoas, cada uma com o seu agente?
2. **Onde ficam os arquivos?** Só no PC do usuário (a TV precisa estar nele ou na mesma rede) ou também na nuvem, para tocar em qualquer lugar? (ver TRD, seção 5)
3. **Vai ser distribuído publicamente?** Muda a postura sobre direitos autorais e o tipo de assinatura de código.
4. **Plataformas:** só Windows na primeira versão?
5. **Nome e identidade** do instalador e do agente.
