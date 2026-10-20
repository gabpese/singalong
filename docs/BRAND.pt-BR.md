---
plugin: grill (grill-core + roast, método adaptado de código para identidade de marca)
date: 2026-10-16
target: apps/web, apps/desktop/ui, PRD.pt-BR.md
style: Hard-Nosed Critique + Roadmap
status: direção, paleta B e logotipo aprovados pelo dono em 2026-10-16; aplicados na interface (web e app instalável) na branch release/1.4.0-design
---

# Singalong — conceito de marca

[English](BRAND.md) · **Português (Brasil)**

Escrito para: o dono do produto, para decidir a direção antes de qualquer nova rodada de interface.

## 1. Veredito em um parágrafo

A interface ficou com "cara de IA" por um motivo anterior a qualquer fonte ou cor: **ela não tem uma ideia de marca**. A briefing da 1.4.0 pediu "Cyber-Club / Dark Arcade" e "tela de aguardando jogadores de videogame", e eu executei isso. Só que o PRD descreve outra coisa: um karaokê **de casa, entre amigos, sem assinatura e sem catálogo fechado**, em que a TV é o palco e o celular é o controle. Ninguém ali é "jogador", e a sala não é um clube. Enquanto a metáfora estiver errada, qualquer paleta que eu escolher vai parecer um template, porque não há de onde ela vir.

## 2. O roast da identidade atual

- **[HIGH] A metáfora (videogame/clube) contradiz o produto.**
  - **Evidência:** `PRD.pt-BR.md` §3 chama as pessoas de anfitrião e cantor/convidado, e `Lobby.tsx` + `tvp.lobbyTitle` usam a linguagem de lobby de jogo.
  - **Proposta:** trocar a metáfora por uma que nasça do uso real (seção 4). `[< 1 day]` para decidir, o resto vem depois.
  - **Tradeoff:** perde o apelo "gamer" que o briefing pediu; ganha coerência e algo que ninguém mais tem.
- **[HIGH] Não existe nenhum elemento que seja só do Singalong.**
  - **Evidência:** `style.css` hoje é fonte display + um coral + cartões escuros; trocando o nome, serve para qualquer app. O único traço realmente próprio do produto é o preenchimento palavra a palavra da letra (`.current .w`, `lyrics-view.ts`), e ele está tratado como detalhe.
  - **Proposta:** construir a marca em volta de duas coisas que só o produto faz: **a letra que se acende palavra a palavra** e **"agora é a sua vez"**.
  - **Tradeoff:** a marca fica mais específica (e menos "segura"); em troca, é reconhecível em uma captura de tela.
- **[MEDIUM] O ícone e o logo contam outra história.**
  - **Evidência:** `public/icons/singing.svg` é um disco de vinil/toca-discos (sugere DJ ou player, não cantar), e o `apps/desktop/ui/icon.png` é amarelo ao lado de um app coral, como se viu na captura da tela de boas-vindas.
  - **Proposta:** um logotipo só, usado no site, no app, na bandeja e no instalador (seção 6). `[< 1 week]`
- **[MEDIUM] `welcome.png` ainda carrega a paleta antiga** (azul, roxo e amarelo) e aparece na Home e no app.
  - **Proposta:** refazer depois que a paleta for decidida; não antes. `[< 1 day]`
- **[MEDIUM] A voz dos textos oscila.** "Você é o anfitrião: escolhe a ordem" (didático), "Isolando a banda…" (lúdico) e "Aplausos para você" (genérico) não parecem da mesma pessoa. Proposta: seção 5.
- **[LOW] As reações são emojis do sistema** (`lib/reactions.ts`), fora da marca. Proposta: um conjunto próprio de cinco, desenhado junto com o logotipo.
- **[GOOD]** O dueto usa cor **e** forma (círculo, quadrado, losango) e passou no axe. Isso é decisão de marca (acessível sem alarde) e deve virar princípio. Os tokens estão num só arquivo (`theme-bridge.css`), então trocar a identidade custa dias, não semanas.

## 3. O que a interface deve transmitir (em ordem de importância)

1. **"É nosso."** A confiança vem de a interface ser simples e honesta, sem truques. A marca **não fala de preço, de assinatura nem de anúncio**: o texto fala de cantar, não de condições.
2. **"Não precisa ser cantor."** É um lugar de cantores amadores, **muito bem cuidado**. O cuidado aparece no acabamento (alinhamento, tipografia, estados vazios, mensagens), nunca em pose de show profissional. Ninguém deve sentir que precisa merecer o palco.
3. **"Todo mundo entra."** Entrar numa sala leva segundos e não pede cadastro. Nada na tela deve parecer feito para quem já sabe.
4. **"Agora é a sua vez."** Em qualquer tela, de longe ou com uma mão só, dá para saber de quem é a vez e qual é a próxima.
5. **"Sem pressão."** A nota é diversão (está marcada como beta). Ninguém é exposto ou comparado de forma humilhante.

**O que a marca não é:** gamer, balada, corporativa, "plataforma", nem "assistente de IA".

## 4. Ideia central

**"Passa o microfone."**

Karaokê em casa é um microfone que passa de mão em mão. A marca é sobre essa passagem: a letra se acende palavra a palavra (a luz vai de uma palavra à outra), e a vez passa de uma pessoa à outra (a luz vai de uma pessoa à outra). O visual é **cartaz de show de bairro, em versão noturna**: papel e tinta, uma sala de estar à noite, com um único foco de luz.

Por que essa e não "sala de estar aconchegante" genérica: aconchego sozinho vira o visual padrão de qualquer app "caloroso". O cartaz dá ao TV um formato próprio (a música da vez como manchete) e é difícil de gerar no piloto automático.

**Atributos:** caloroso, coletivo, direto, generoso, brincalhão sem ser infantil.

## 5. Voz e texto

- Português do Brasil, informal, frases curtas, verbo no começo. Fale como quem convida para a sala, não como um manual.
- Sem exclamação em série, sem "Oops!", sem "Aplausos para você". O humor é pequeno e específico à situação.
- Vocabulário próprio: **sala, vez, fila, palco, roda** e **Jukebox**. O Jukebox é o lugar onde ficam as músicas já processadas, e esse é o nome dele em todo o app (hoje a tela diz "Músicas já processadas"; passa a dizer Jukebox). Evitar: jogador, partida, sessão, plataforma, processamento, biblioteca.
- Nada de preço: sem "grátis", "sem assinatura", "sem anúncio", "custo zero" em nenhum texto do app ou da Home.
- Antes e depois:
  - "Aguardando cantores…" → mantém. É curto e certo.
  - "Isolando a banda…" → mantém. É a melhor linha do app, e mostra o tom: técnica explicada como cena.
  - "Acabou! Aplausos para você." → "Acabou. Quem é o próximo?"
  - "Você é o anfitrião: escolhe a ordem, pula e pausa." → "Você manda na ordem: pula, pausa, escolhe quem canta."

## 6. Direção visual (recomendada) e alternativas

**Recomendada: "Cartaz de bairro à noite".**
- **Cor (paleta B, aprovada):** noite `#16110f`, papel creme `#f0e4cd`, tomate `#e0432c` (a tinta de destaque da interface) e mostarda `#e8a933`, que é **só de apoio** (logotipo, cartazes, detalhes do ícone) e nunca vira botão nem estado da interface. O dueto mantém turquesa, violeta e amarelo, porque são funcionais.
- **Tipografia:** títulos em grotesca pesada e condensada, de cartaz (candidata: Archivo, com eixo de largura; alternativa: manter Bricolage Grotesque, que já está instalada). Texto e interface em Geist. Duas famílias, nada além.
- **Logotipo:** "singalong" em minúsculas, pesado, em duas tintas (creme com um leve desalinhamento em tomate, como impressão simples). No canto superior direito, **fora das letras**, a **placa "AO VIVO"**, igual às de estúdio quando está gravando: inclinada, com borda dupla e parafusos, um pouco gasta (riscos, uma letra falhando) e **piscando de forma irregular**. Ela acende quando a sala está no ar. É arrumadinha: gasta, mas funcionando. **Ícone:** vinil preto com o selo vermelho e o microfone na frente, num quadrado de papel creme (adesivo de cartaz). Arquivos: `brand/mark.svg`, `brand/mark-dark.svg`; a prévia está em `brand/preview.html`.
- **Textura:** papel com grão, bordas irregulares, fita adesiva em mostarda, retícula de pontos vermelhos num canto, leve inclinação. Impressão em duas tintas, nada de vidro, gradiente nem brilho (a placa é o único "brilho", porque é uma placa de verdade).
- **Imagem:** nenhuma foto de banco. Se houver imagem, é ilustração própria em duas tintas (creme e vermelho) sobre o fundo escuro.
- **Movimento:** só duas coisas se mexem de verdade, e as duas são a marca: o preenchimento da palavra e a passagem da vez (um corte rápido de cartaz). O resto é estático.

**Alternativas (e por que não):**
- **"Sala de estar à noite"** (âmbar e creme, luz de abajur): bonita e segura, mas é o que todo app "aconchegante" faz, e não dá ao TV um formato próprio. Serve de plano B.
- **"Fita cassete e letreiro retrô"**: tem personalidade, mas é um clichê de nostalgia que envelhece e puxa o app para o lado "estética" em vez de "uso".

## 7. Como cada tela aplica a ideia

- **Home:** a porta de entrada. Duas escolhas, uma dominante ("criar a festa") e uma discreta ("entrar com código"), e uma frase curta sobre cantar qualquer música com os amigos (sem falar de preço).
- **TV:** o cartaz. A música da vez é a manchete, vista de longe; um elemento por vez; "quem canta" e "quem é o próximo" sempre legíveis a 4 m.
- **Celular:** o controle remoto da sala. Uma ação principal por tela, alvos grandes, polegar, boa leitura com pouca luz (o ambiente é uma festa à noite).
- **App instalável:** os bastidores. Mais quieto e utilitário; a mesma tipografia e cor, sem decoração.

## 8. Decisões do dono (fechadas em 2026-10-16)

| Decisão | Resposta |
|---|---|
| Para quem é | Amigos, família, bares e eventos. Mesmo em bar ou evento, quem usa são amigos e família, então o tom é o mesmo |
| Humor na voz | Pouco |
| Falar de preço (grátis, sem assinatura) | Não. A marca não comenta valores |
| Nome | Singalong |
| Idiomas da marca | Português; inglês e espanhol seguem a tradução da interface |
| Ícone | Vinil (saudosismo), agora com um microfone junto, para lembrar karaokê |
| Jukebox | É o nome do lugar das músicas já processadas, em todo o app (outra lembrança de como se ouvia música) |
| Direção visual | Cartaz de bairro à noite, aprovada; logotipo com o "ao vivo" aprovado como ideia |

## 9. Resumo executivo

- **Confiança:** Alta de que a metáfora de videogame estava errada (o PRD diz o contrário). Média na direção "cartaz de bairro", que é a minha melhor aposta mas só um teste com 2 ou 3 pessoas reais em uma festa confirma. Baixa na cor exata do vermelho até passar no contraste.
- **As 3 ações, se só der para fazer três:**
  1. Aprovar o logotipo (rascunho em `brand/`). `[< 1 day]`
  2. Desenhar o logotipo e o ícone único, e trocar `singing.svg`, `icon.png` e o favicon. `[< 1 week]`
  3. Redesenhar só a TV como cartaz (a tela mais vista e a mais própria do produto), antes de mexer no resto. `[< 1 week]`

## 10. Plano de execução

1. **Fase 1, decisão (feita):** seção 8 respondida; falta só aprovar o logotipo.
2. **Fase 2, fundação (1 semana):** tokens novos em `theme-bridge.css` (e a cópia do app), fontes, logotipo, ícone, favicon e `welcome.png` refeito.
3. **Fase 3, telas (1 a 2 semanas):** TV, depois celular, depois Home, depois o app instalável, com captura de tela e axe a cada passo.
4. **Fase 4, validação:** colocar a TV e um celular numa sala com gente que não conhece o projeto e perguntar "de quem é a vez?" e "o que é isso?", sem explicar.

## 11. O que já foi aplicado (2026-10-16)

- **Tokens:** paleta B em `theme-bridge.css` (e na cópia do app). Na tela o tomate é `#ea5a3f` (passa no contraste com texto escuro); sobre o papel ele escurece para `#c2371f`. O logotipo em arquivo usa `#e0432c`.
- **Logotipo:** componente `ui/Logo.tsx` (palavra em duas tintas + placa "AO VIVO" piscando, traduzida para "LIVE" e "EN VIVO"). Aparece onde a placa fica legível: a Home e o cartaz da TV. Nos tamanhos pequenos vai a marca (`/brand/mark.svg`): favicon, topo da sala, ícone do app, bandeja e instalador (`build/icon.ico` com 7 tamanhos e `build/icon.png` de 1024 px, regerados por `scripts/make-icon.cjs` a partir de `brand/mark.svg`).
- **Home:** o card da festa é um cartaz (papel, fita, retícula, "Passa o microfone."), com "Entrar em uma sala" e "Baixar o app" ao lado. A imagem antiga (`welcome.png`) saiu da Home; no lugar, a marca colada como um cartaz.
- **TV:** a espera é um cartaz colado na parede (logotipo, "Aguardando cantores…", QR code com sombra de carimbo, código e os cantores que entram). Tocando, a fila virou um bilhete de papel com fita, o nome de quem canta tem a tinta desalinhada e o cartão da letra ganhou a retícula num canto.
- **Celular:** a aba e a lista das músicas prontas se chamam **Jukebox**; a marca entra no topo da sala.
- **App instalável:** mesmos tokens e fontes, a marca no lugar do ícone amarelo, a tela de início com a marca colada como cartaz ("Passa o microfone.") e o card de importar chamado Jukebox.
- **Ainda pendente:** `welcome.png` (ainda com a paleta antiga) não é mais usado em nenhuma tela; ou é refeito com capturas novas, ou sai do repositório. As reações continuam emojis.
- **Ajustes de 2026-10-16 (depois):**
  - **Vermelho no lugar do tomate**, que parecia laranja. São três intensidades do mesmo vermelho, por contraste: `#d62828` para preencher (botões, aba ativa), com texto claro `#fff8ee` por cima; `#ff6b6b` como texto e traço sobre o escuro (a letra que se acende, a placa "AO VIVO", links); `#b91c1c` sobre o papel. A marca em arquivo (`brand/mark.svg`) e os ícones do app foram refeitos com o mesmo vermelho.
  - **Idioma por bandeiras:** Brasil, Estados Unidos e Espanha, em SVG (emoji de bandeira não aparece no Windows); o nome do idioma fica no rótulo e na dica.
  - **Avatares com personalidade:** cada celular na sala de espera vira um bichinho do [blobatar](https://github.com/Alain00/blobatar) (MIT, sem dependências), feito a partir do nome e desenhado no próprio app (nenhum nome sai para servidor de terceiros). Eles respiram e piscam; quem pede menos movimento os vê parados.
  - **Sala sem limite de cantores:** o servidor não limita quantos celulares entram. O cartaz mostra no mínimo 4 lugares (vagas livres) e no máximo 7 numa fileira; passando disso, o último vira "+N".
  - **O bichinho de quem canta** aparece também ao lado do nome em "Cantando agora" e "Próximo" na TV, na fila da TV, na música tocando e na fila do celular. Num dueto aceito aparecem os dois, um encostado no outro (com convite ainda pendente, só o de quem adicionou). Só o de "Cantando agora" na TV se mexe; nas listas eles ficam parados. No fundo escuro o bicho ganha um contorno creme de adesivo, porque alguns tons são escuros; no papel, a sombra de carimbo.
