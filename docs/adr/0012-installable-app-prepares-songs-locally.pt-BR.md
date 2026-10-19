---
status: aceito
date: 2026-10-19
---

# 0012. As músicas são preparadas no computador de cada usuário

[English](0012-installable-app-prepares-songs-locally.md) · **Português (Brasil)**

O Singalong não gera receita, então o dono não quis pagar por um servidor potente o bastante para separar as músicas, nem deixar o próprio computador ligado processando músicas para todo mundo. Em vez disso, o app instalável prepara o que o preparo de uma música precisa (Python, PyTorch, ffmpeg: o Motor) e o computador de cada usuário prepara as músicas dele. Baixar pela conexão de casa do usuário também evita o bloqueio do YouTube a endereços de nuvem (medido: 0 de 8 vídeos pela VM). O app é feito com Electron para reaproveitar as páginas da TV e do anfitrião, deixando um lugar só para mudar quando as telas mudam.

## Alternativas consideradas

- **Um servidor pago com GPU**: rejeitado; custa dinheiro ([ADR 0001](0001-zero-cost-while-non-profit.pt-BR.md)), e o YouTube o bloquearia do mesmo jeito.
- **O computador do dono prepara as músicas de todos**: rejeitado; ele precisaria ficar ligado sempre que alguém cantasse.
- **Um instalador com tudo dentro**: rejeitado; vários gigabytes por release, e redistribuir builds do PyTorch e do ffmpeg pesa nas licenças. O Motor é montado na primeira execução a partir das fontes oficiais, fixadas com checksums SHA-256.
- **Tauri no lugar do Electron**: rejeitado; o Electron roda o mesmo Chromium no Windows, no macOS e no Linux, então o áudio e o microfone da TV se comportam igual em todo lugar, enquanto o Tauri traz Rust e usa o WebKit fora do Windows ([ADR 0016](0016-no-full-stack-framework.pt-BR.md)).

## Consequências

- A primeira execução baixa e monta o Motor (CPU, ou uma GPU compatível quando houver).
- As músicas novas de uma Sala dependem do app do Dono estar aberto; as já preparadas continuam tocando.
