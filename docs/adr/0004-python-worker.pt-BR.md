---
status: aceito
date: 2026-10-19
---

# 0004. O worker é Python

[English](0004-python-worker.md) · **Português (Brasil)**

As ferramentas que tornam o Singalong possível só são maduras em Python, sobre o PyTorch: o Demucs separa a voz, o Whisper (via stable-ts) alinha a letra a ela, e o yt-dlp baixa o áudio. Não há equivalente sério em JavaScript, então nenhuma stack de uma linguagem só, Flutter incluído, tiraria o Python do projeto.

## Consequências

- O projeto mantém duas linguagens de vez: JavaScript/TypeScript em tudo o que as pessoas tocam e Python no trabalho de áudio.
- Os dois lados se encontram só por contratos em JSON (um stream do Redis e a API HTTP `/agent/v1`), nunca por código compartilhado.
