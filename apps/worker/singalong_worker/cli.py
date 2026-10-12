import argparse
import json
import os
from pathlib import Path

from .cookies import load_policy
from .errors import classify
from .logsetup import setup_logging
from .pipeline import NeedsLyrics, process
from .storage import LocalStorage


def _import(args) -> int:
    """Importa um arquivo ou um link de fonte aberta e, se o agente está configurado, publica a música no catálogo da nuvem."""
    from .errors import JobError
    from .importer import import_song

    if args.import_file and args.import_url:
        print("erro: use --import OU --import-url, não os dois")
        return 2
    storage = LocalStorage(args.storage_root)
    lyrics_text = args.lyrics_file.read_text(encoding="utf-8") if args.lyrics_file else None
    try:
        meta = import_song(
            storage, file=args.import_file, url=args.import_url, artist=args.artist, title=args.title, lyrics_source=args.lyrics,
            lyrics_text=lyrics_text, device=args.device, langs=args.langs.split(","), force=args.force, lyrics_loose=args.loose,
            on_stage=lambda stage: print(f"... {stage}", flush=True),
        )
    except ValueError as exc:
        print(f"erro: {exc}")
        return 2
    except NeedsLyrics as exc:
        print(f"needs_lyrics: {exc}")
        return 3
    except JobError as exc:
        print(f"erro ({exc.code}): {exc.message}")
        return 4
    except Exception as exc:  # noqa: BLE001 - na CLI toda falha vira uma mensagem clara, como no worker
        err = classify(exc)
        print(f"erro ({err.code}): {err.message}")
        return 4
    print(f"Pronto: {meta.get('artist')} - {meta.get('title')}  ({meta['video_id']}, letra: {meta.get('lyrics_source')})")
    _publish_import(storage, meta["video_id"])
    return 0


def _publish_import(storage, video_id: str) -> None:
    """Com AGENT_URL e AGENT_TOKEN, a música entra já no catálogo da nuvem (o agente em execução não precisa reiniciar)."""
    url, token = os.environ.get("AGENT_URL"), os.environ.get("AGENT_TOKEN")
    if not (url and token):
        print("(sem AGENT_URL/AGENT_TOKEN: a música fica só na biblioteca local; o agente a publica quando iniciar)")
        return
    from .backend import HttpBackend

    backend = HttpBackend(url, token)
    backend.attach_storage(storage)
    backend.publish_song(video_id, force=True)
    if video_id in backend._shared.unpublished:
        print("aviso: não consegui publicar no catálogo agora; o agente a publica quando iniciar")
    else:
        print("Publicada no catálogo do agente: já aparece na biblioteca das suas salas.")


def _youtube_login(args) -> int:
    from .youtube_login import LoginError, check_login, login

    try:
        file = login(None if args.youtube_login == "auto" else args.youtube_login)
    except LoginError as exc:
        print(f"erro: {exc}")
        return 2
    from .cookies import CookieSource

    state, detail = check_login(CookieSource(file=file))
    print({"connected": "Conectado ao YouTube.", "not-logged": "Os cookies foram guardados, mas o YouTube não reconheceu a sessão: tente o login de novo.",
           "error": f"Cookies guardados; não consegui verificar agora ({detail})."}.get(state, state))
    return 0 if state in ("connected", "error") else 1


def _check_update(args) -> int:
    from .version import check_update, current_version

    print(f"Versão instalada: {current_version()}")
    if not args.agent_url:
        print("erro: informe --agent-url (ou AGENT_URL) com o endereço do servidor")
        return 2
    info = check_update(args.agent_url)
    if info is None:
        print("Não consegui consultar o servidor agora.")
        return 4
    messages = {"ok": "Você está com a versão mais recente.", "update_available": f"Há uma versão nova: {info.get('latest')}.",
                "update_required": f"Esta versão é antiga demais; atualize para {info.get('minimum') or info.get('latest')} ou mais nova.",
                "unknown": "O servidor não informou versões."}
    print(messages.get(info.get("status"), "Resposta inesperada do servidor."))
    for key, label in (("notes", "O que mudou"), ("url", "Onde baixar")):
        if info.get(key):
            print(f"{label}: {info[key]}")
    return 1 if info.get("status") == "update_required" else 0


def _youtube_status() -> int:
    from .youtube_login import main_status

    return main_status(load_policy().source)


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
    p.add_argument("--cookies", type=Path, default=None, help="cookies.txt (formato Netscape) para o yt-dlp: com ele, sempre usa a conta (sem ele vale YTDLP_COOKIES_POLICY)")
    p.add_argument("--import", dest="import_file", type=Path, metavar="ARQUIVO", help="importa um arquivo de áudio SEU (mp3, flac, wav, m4a, ogg, opus) para a biblioteca, sem passar pelo YouTube; use com --artist e --title (se as etiquetas não tiverem)")
    p.add_argument("--import-url", metavar="LINK", help="importa a faixa de um link de SoundCloud, Bandcamp ou Internet Archive (sem cookies; só quando o autor permite baixar)")
    p.add_argument("--youtube-login", nargs="?", const="auto", metavar="NAVEGADOR", help="entra no YouTube pelo Chrome ou pelo Edge (perfil só do agente) e guarda os cookies; NAVEGADOR: chrome, edge ou auto")
    p.add_argument("--youtube-status", action="store_true", help="confere se o login do YouTube do agente está valendo")
    p.add_argument("--hardware", action="store_true", help="mostra o hardware detectado e o motor recomendado (cu121 ou cpu)")
    p.add_argument("--selftest", action="store_true", help="com --hardware: roda uma convolução na GPU para confirmar que ela funciona")
    p.add_argument("--version", action="store_true", help="mostra a versão instalada do app")
    p.add_argument("--check-update", action="store_true", help="pergunta ao servidor (--agent-url) se há versão nova do app")
    p.add_argument("--artist", help="artista para buscar a letra (sobrescreve a detecção)")
    p.add_argument("--title", help="título da música para buscar a letra (sobrescreve a detecção)")
    p.add_argument("--force", action="store_true", help="ignora e refaz o cache")
    args = p.parse_args(argv)
    setup_logging(level="INFO")

    if args.hardware:
        from .hardware import main as hardware_main

        return hardware_main(["--selftest"] if args.selftest else [])
    if args.version:
        from .version import current_version

        print(current_version())
        return 0
    if args.check_update:
        return _check_update(args)
    if args.import_file or args.import_url:
        return _import(args)
    if args.youtube_login:
        return _youtube_login(args)
    if args.youtube_status:
        return _youtube_status()
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
            args.url, storage, args.lyrics, lyrics_text, args.device, args.langs.split(","), args.force, args.cookies or load_policy(),
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
