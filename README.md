# singalong
A project viewing help you sing your favorite songs, being them a cover or no.

Plano completo: [PLANO.md](PLANO.md).

## Como rodar (Fases 0 e 1)

**1. Processar uma música** (worker, precisa de Docker; `secrets/youtube_cookies.txt` com cookies do YouTube):

```powershell
docker compose --profile gpu run --rm worker-gpu "<link do YouTube>" --device cuda
```

Sem GPU, use `--profile cpu` e o serviço `worker`. Sem legenda no vídeo, escolha a letra com
`--lyrics lrclib` ou `--lyrics text --lyrics-file /storage/inputs/letra.txt` (texto puro, uma linha por verso,
com os tempos do LRCLIB; `--artist`/`--title` ajudam quando o vídeo é um cover).
O resultado fica em `storage/cache/<video_id>/` (`instrumental.mp3`, `lyrics.json`, `meta.json`).

**2. Abrir o player** (Node 20+, sem dependências):

```powershell
cd apps/web
npm start        # http://localhost:3000
npm test
```

Atalhos: `Espaço` toca/pausa, `↑`/`↓` muda o tom (±6 semitons), `F` tela cheia.
O "Ajuste da letra" corrige o atraso da letra por música (salvo no navegador).

Testes do worker: `cd apps/worker; python -I -m unittest discover -s tests -t .`
