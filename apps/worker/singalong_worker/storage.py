"""Driver de storage local. Contrato: exists/put/get_url/read/delete/list (PLANO.md, seção 14).

O restante do código só conhece chaves lógicas ("cache/<video_id>/instrumental.mp3").
"""
import os
import shutil
from pathlib import Path


class LocalStorage:
    def __init__(self, root: str | os.PathLike, public_base_url: str = "http://localhost:3000/media"):
        self.root = Path(root).resolve()
        self.public_base_url = public_base_url.rstrip("/")

    def _path(self, key: str) -> Path:
        path = (self.root / key).resolve()
        if path != self.root and self.root not in path.parents:
            raise ValueError(f"chave inválida: {key!r}")
        return path

    def exists(self, key: str) -> bool:
        return self._path(key).is_file()

    def put(self, key: str, local_path: str | os.PathLike) -> None:
        dest = self._path(key)
        dest.parent.mkdir(parents=True, exist_ok=True)
        tmp = dest.with_name(dest.name + ".tmp")
        shutil.copyfile(local_path, tmp)
        os.replace(tmp, dest)  # atômico: nunca existe artefato pela metade

    def get_url(self, key: str, ttl: int = 3600) -> str:
        self._path(key)  # valida a chave
        return f"{self.public_base_url}/{key}"

    def read(self, key: str) -> bytes:
        return self._path(key).read_bytes()

    def delete(self, prefix: str) -> None:
        path = self._path(prefix)
        if path.is_dir():
            shutil.rmtree(path)
        elif path.exists():
            path.unlink()

    def list(self, prefix: str = "") -> list[str]:
        base = self._path(prefix) if prefix else self.root
        if base.is_file():
            return [prefix]
        if not base.exists():
            return []
        return sorted(
            p.relative_to(self.root).as_posix()
            for p in base.rglob("*")
            if p.is_file() and not p.name.endswith(".tmp")
        )
