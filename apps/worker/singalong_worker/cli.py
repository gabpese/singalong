import argparse
import json
import os
from pathlib import Path

from .errors import classify
from .logsetup import setup_logging
from .pipeline import NeedsLyrics, process
from .storage import LocalStorage


def _pair(args) -> int:
    from .backend import BackendUnavailable, Rejected, pair

    if not args.agent_url:
        print("erro: informe --agent-url (ou AGENT_URL) com o endereço do servidor")
        return 2
    try:
        result = pair(args.agent_url, args.pair, args.agent_name)
    except Rejected as exc:
        print(f"erro: {exc.message or exc.code}")
        return 2
    except BackendUnavailable as exc:
        print(f"erro: não consegui falar com o servidor ({exc})")
        return 4
    print("Pareado. Guarde o token (ele só aparece agora) na variável AGENT_TOKEN:")
    print(f"AGENT_TOKEN={result['token']}")
    return 0


def _create_room(args) -> int:
    from .backend import AuthError, BackendUnavailable, HttpBackend, Rejected

    token = os.environ.get("AGENT_TOKEN")
    if not (args.agent_url and token):
        print("erro: defina AGENT_URL e AGENT_TOKEN (o token do pareamento)")
        return 2
    backend = HttpBackend(args.agent_url, token, args.agent_name)
    try:
        backend.connect(keep_name=True)  # retoma a sessão do agente em execução, sem trocar o apelido dela (ou inicia uma)
        room = backend.create_room()
    except (AuthError, Rejected) as exc:
        print(f"erro: {exc}")
        return 2
    except BackendUnavailable as exc:
        print(f"erro: não consegui falar com o servidor ({exc})")
        return 4
    # os links são para o NAVEGADOR: em Docker o servidor se chama http://api:3000 por dentro e http://localhost:3000 por fora
    base = (args.public_url or args.agent_url).rstrip("/")
    print(json.dumps({"code": room["code"], "host_token": room["host_token"]}))
    print(f"TV:        {base}/tv.html?room={room['code']}")
    print(f"Anfitrião: {base}/room.html?room={room['code']}#host={room['host_token']}")
    print(f"Convidados entram pelo código {room['code']} ou pelo QR code da TV.")
    return 0


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="singalong_worker", description="YouTube -> instrumental + letra sincronizada")
    p.add_argument("url", nargs="?", help="link do YouTube (ou ID de 11 caracteres); omitido com --consume")
    p.add_argument("--consume", action="store_true", help="modo serviço: consome jobs do Redis (REDIS_URL) ou, com AGENT_URL, do servidor por HTTP (agente local)")
    p.add_argument("--pair", metavar="CODIGO", help="agente local: troca o código de pareamento por um token (use com --agent-url); imprime o token")
    p.add_argument("--agent-url", default=os.environ.get("AGENT_URL") or None, help="endereço do servidor (ex.: https://singalong.exemplo.org)")
    p.add_argument("--agent-name", default=os.environ.get("AGENT_SESSION_NAME") or "Meu computador", help="nome deste computador no pareamento / apelido da sessão")
    p.add_argument("--public-url", default=os.environ.get("PUBLIC_URL") or None, help="endereço que o navegador usa para abrir a sala (padrão: o mesmo de --agent-url); com Docker, http://localhost:3000")
    p.add_argument("--create-room", action="store_true", help="agente local: cria uma sala na sua sessão (AGENT_URL + AGENT_TOKEN) e imprime o link de anfitrião")
    p.add_argument("--lyrics", choices=["auto", "video", "lrclib", "file", "text", "align", "none"], default="auto")
    p.add_argument("--loose", action="store_true", help="aceita letra online de versão com duração diferente da do vídeo")
    p.add_argument("--lyrics-file", type=Path, help="com --lyrics file: .lrc/.srt/.vtt com tempos; com --lyrics text ou align: texto puro, uma linha por verso")
    p.add_argument("--device", choices=["cpu", "cuda"], default=os.environ.get("DEMUCS_DEVICE") or None, help="dispositivo do demucs (padrão: automático)")
    p.add_argument("--langs", default="pt,en", help="idiomas de legenda, separados por vírgula")
    p.add_argument("--storage-root", default=os.environ.get("STORAGE_ROOT", "./storage"))
    p.add_argument("--cookies", type=Path, default=os.environ.get("YTDLP_COOKIES") or None, help="cookies.txt (formato Netscape) para o yt-dlp")
    p.add_argument("--artist", help="artista para buscar a letra (sobrescreve a detecção)")
    p.add_argument("--title", help="título da música para buscar a letra (sobrescreve a detecção)")
    p.add_argument("--force", action="store_true", help="ignora e refaz o cache")
    args = p.parse_args(argv)
    setup_logging(level="INFO")

    if args.pair:
        return _pair(args)
    if args.create_room:
        return _create_room(args)
    if args.consume:
        from .consumer import run  # importa só aqui: o modo CLI não precisa do cliente Redis

        return run()
    if not args.url:
        p.error("informe a url (ou use --consume)")

    storage = LocalStorage(args.storage_root)
    lyrics_text = args.lyrics_file.read_text(encoding="utf-8") if args.lyrics_file else None
    try:
        meta = process(
            args.url, storage, args.lyrics, lyrics_text, args.device, args.langs.split(","), args.force, args.cookies,
            args.artist, args.title, lyrics_loose=args.loose,
        )
    except ValueError as e:
        print(f"erro: {e}")
        return 2
    except NeedsLyrics as e:
        print(f"needs_lyrics: {e}")
        return 3
    except Exception as e:  # noqa: BLE001 - na CLI toda falha vira uma mensagem clara, como no worker
        err = classify(e)
        print(f"erro ({err.code}): {err.message}")
        return 4
    print(json.dumps(meta, ensure_ascii=False, indent=2))
    return 0
