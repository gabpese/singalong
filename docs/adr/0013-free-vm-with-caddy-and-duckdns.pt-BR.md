---
status: aceito
date: 2026-10-19
---

# 0013. Uma VM gratuita atrás do Caddy, num endereço do DuckDNS

[English](0013-free-vm-with-caddy-and-duckdns.md) · **Português (Brasil)**

O servidor público é uma VM do plano Always Free da Oracle Cloud ([ADR 0001](0001-zero-cost-while-non-profit.pt-BR.md)). O DuckDNS dá o subdomínio gratuito, o que deixa o dono no controle do endereço. O Caddy obtém e renova o certificado HTTPS sozinho; o HTTPS é obrigatório, porque o navegador só libera o microfone e o AudioWorklet da troca de tom em páginas seguras.

## Alternativas consideradas

- **Planos gratuitos de plataformas (Render e parecidos)**: rejeitado; eles dormem quando ficam parados e perdem as Salas guardadas em memória e em disco.

## Consequências

- **Mudar para um domínio próprio** se o endereço do DuckDNS se mostrar limitante, ou quando o projeto gerar receita.
