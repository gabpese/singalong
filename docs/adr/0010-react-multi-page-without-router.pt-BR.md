---
status: aceito
date: 2026-10-19
---

# 0010. React, com uma página por tela e sem roteador

[English](0010-react-multi-page-without-router.md) · **Português (Brasil)**

O site passou de JavaScript escrito à mão para React porque as telas da Sala, da TV e do Palco são desenhadas a partir do estado, em vez de atualizar o DOM à mão, e porque o React é a biblioteca de interface mais pedida nas vagas a que o dono se candidata. Ele continua como quatro páginas do Vite (`index.html`, `room.html`, `tv.html`, `stage.html`), sem roteador: as URLs, o QR code da TV e os links de anfitrião precisavam continuar iguais, e cada tela é independente. A migração foi feita atrás de 34 testes de ponta a ponta escritos antes, que passaram sem mudança antes e depois.
