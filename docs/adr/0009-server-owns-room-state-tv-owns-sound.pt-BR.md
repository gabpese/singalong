---
status: aceito
date: 2026-10-19
---

# 0009. O servidor é dono da Sala; a TV é dona do som

[English](0009-server-owns-room-state-tv-owns-sound.md) · **Português (Brasil)**

O estado da Sala (a Fila, de quem é a Vez, os ajustes, o Intervalo) vive no servidor e vai para todos os aparelhos por WebSocket. A TV toca a música e informa onde ela está; os celulares só pedem ações. Assim celulares e TV nunca discordam, e uma TV recarregada no meio da música continua de onde estava.

## Consequências

- Fases com tempo, como o Intervalo, são decididas pelo servidor; os aparelhos recebem quanto tempo falta e contam sozinhos, então os relógios deles não precisam bater.
- Mudar a posição da música é um pedido que o servidor repassa à TV, porque só a TV sabe a posição real.
