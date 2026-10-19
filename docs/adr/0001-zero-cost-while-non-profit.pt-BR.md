---
status: aceito
date: 2026-10-19
---

# 0001. Custo zero enquanto o projeto não gera receita

[English](0001-zero-cost-while-non-profit.md) · **Português (Brasil)**

O Singalong é um projeto sem fins lucrativos, então cada parte dele roda de graça: uma VM do plano Always Free da Oracle Cloud, Caddy e DuckDNS para o endereço e o HTTPS, GitHub Actions para o CI e o GitHub Container Registry para as imagens, e o computador de cada usuário para o trabalho pesado de preparar as músicas. Escolher o que é gratuito é uma decisão consciente, não um descuido; os outros ADRs partem dela.

## Consequências

- O servidor na nuvem é pequeno (2 CPUs e 12 GB no plano gratuito) e não consegue preparar músicas ([ADR 0012](0012-installable-app-prepares-songs-locally.pt-BR.md)).
- Os instaladores não têm assinatura digital, então Windows e macOS avisam na primeira execução.
- O deploy na VM é um `./deploy.sh` manual enquanto `DEPLOY_ENABLED` estiver desligado.
- **Rever quando o projeto começar a gerar receita**: um servidor pago, um domínio próprio, certificados de assinatura e deploy automático ([ROADMAP](../ROADMAP.pt-BR.md)).
