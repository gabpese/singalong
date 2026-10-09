"""Atualização segura do meta.json de uma música.

Várias tarefas em segundo plano (título do vídeo, tom, vozes de apoio) completam o meta.json de músicas já prontas. Cada
uma LÊ, MUDA e GRAVA o arquivo inteiro; sem coordenação, uma sobrescreveria a mudança da outra. Aqui a leitura acontece
dentro do trava (lock), então a mudança parte sempre do arquivo mais recente. O cálculo demorado (o tom, a separação)
fica fora da trava: só o "ler, mudar e gravar" é serializado.
"""
import json
import tempfile
import threading
from collections.abc import Callable
from pathlib import Path

_lock = threading.Lock()


def meta_key(video_id: str) -> str:
    return f"cache/{video_id}/meta.json"


def update_meta(storage, video_id: str, mutate: Callable[[dict], None]) -> dict:
    """Aplica `mutate(meta)` (que altera o dicionário no lugar) ao meta.json mais recente e grava. Devolve o meta novo."""
    key = meta_key(video_id)
    with _lock:
        meta = json.loads(storage.read(key))
        mutate(meta)
        with tempfile.TemporaryDirectory(prefix="singalong-meta-") as tmp:
            updated = Path(tmp) / "meta.json"
            updated.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
            storage.put(key, updated)
    return meta
