"""Verificação do hardware: escolhe o motor (GPU NVIDIA com CUDA 12.1 ou CPU) e confere se a GPU funciona de verdade.

Usa só a biblioteca padrão: roda antes de o torch existir (o instalador decide qual torch baixar) e de novo depois, dentro do
motor instalado, com `gpu_selftest` (uma convolução pequena na GPU). Qualquer falha cai para a CPU, com o motivo."""
import json
import os
import platform
import shutil
import subprocess
import sys

# Driver mínimo do CUDA 12.1 (Windows 527.41, Linux 525.60). Abaixo disso o torch cu121 não enxerga a GPU.
MIN_DRIVER = (527, 41)
# Capacidade de computação que o torch 2.5.1/cu121 traz kernels (Maxwell sm_50 até Ada/Hopper sm_90). A Blackwell (RTX 50, 12.0) fica de fora.
SUPPORTED_COMPUTE = ((5, 0), (9, 0))
MIN_VRAM_MB = 3000  # o Demucs precisa de ~3 GB para separar uma música sem estourar


def _run(cmd: list[str], timeout: float = 15, run=subprocess.run) -> str | None:
    try:
        done = run(cmd, capture_output=True, text=True, timeout=timeout, check=False)
    except (OSError, subprocess.SubprocessError):
        return None
    return done.stdout if done.returncode == 0 else None


def _numbers(text: str) -> tuple[int, ...]:
    parts = []
    for piece in str(text).strip().split("."):
        digits = "".join(ch for ch in piece if ch.isdigit())
        if not digits:
            break
        parts.append(int(digits))
    return tuple(parts)


def nvidia_gpus(run=subprocess.run) -> list[dict]:
    """As placas NVIDIA vistas pelo nvidia-smi (vazio se não há placa ou driver)."""
    exe = shutil.which("nvidia-smi")
    if not exe:
        fallback = os.path.join(os.environ.get("SystemRoot", r"C:\Windows"), "System32", "nvidia-smi.exe")
        exe = fallback if os.path.exists(fallback) else None
    out = _run([exe, "--query-gpu=name,driver_version,memory.total,compute_cap", "--format=csv,noheader,nounits"], run=run) if exe else None
    gpus = []
    for line in (out or "").splitlines():
        cells = [c.strip() for c in line.split(",")]
        if len(cells) < 4:
            continue
        name, driver, memory, compute = cells[:4]
        try:
            vram = int(float(memory))
        except ValueError:
            vram = 0
        gpus.append({"name": name, "driver": driver, "vram_mb": vram, "compute": compute})
    return gpus


def _ram_mb() -> int | None:
    try:
        if os.name == "nt":
            import ctypes

            class Status(ctypes.Structure):
                _fields_ = [("length", ctypes.c_ulong), ("load", ctypes.c_ulong), ("total", ctypes.c_ulonglong), ("avail", ctypes.c_ulonglong),
                            ("tpf", ctypes.c_ulonglong), ("apf", ctypes.c_ulonglong), ("tv", ctypes.c_ulonglong), ("av", ctypes.c_ulonglong), ("ave", ctypes.c_ulonglong)]

            status = Status()
            status.length = ctypes.sizeof(Status)
            ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status))  # type: ignore[attr-defined]
            return int(status.total // 2**20)
        pages, size = os.sysconf("SC_PHYS_PAGES"), os.sysconf("SC_PAGE_SIZE")
        return int(pages * size // 2**20)
    except (OSError, AttributeError, ValueError):
        return None


def choose_engine(gpus: list[dict], force_cpu: bool = False) -> dict:
    """Decide o motor: {"engine": "cu121"|"cpu", "reason": ..., "gpu": {...}|None}. A decisão é só pelas especificações;
    o teste de verdade (`gpu_selftest`) confirma depois de instalar e pode devolver para a CPU."""
    if force_cpu:
        return {"engine": "cpu", "reason": "CPU forçada nas configurações", "gpu": None}
    if not gpus and platform.system() == "Darwin":
        return {"engine": "cpu", "reason": "macOS: o motor roda na CPU por enquanto (a GPU da Apple fica para uma versão futura)", "gpu": None}
    if not gpus:
        return {"engine": "cpu", "reason": "nenhuma placa NVIDIA com driver encontrada", "gpu": None}
    gpu = max(gpus, key=lambda g: g["vram_mb"])
    if _numbers(gpu["driver"]) < MIN_DRIVER:
        return {"engine": "cpu", "reason": f"driver da NVIDIA {gpu['driver']} é antigo para o CUDA 12.1 (precisa de {'.'.join(map(str, MIN_DRIVER))} ou mais novo): atualize o driver", "gpu": gpu}
    compute = _numbers(gpu["compute"])[:2]
    if compute and not (SUPPORTED_COMPUTE[0] <= compute <= SUPPORTED_COMPUTE[1]):
        return {"engine": "cpu", "reason": f"a placa {gpu['name']} (capacidade {gpu['compute']}) ainda não tem suporte no motor atual", "gpu": gpu}
    if gpu["vram_mb"] < MIN_VRAM_MB:
        return {"engine": "cpu", "reason": f"a placa tem só {gpu['vram_mb']} MB de memória (mínimo {MIN_VRAM_MB} MB)", "gpu": gpu}
    return {"engine": "cu121", "reason": f"{gpu['name']} com driver {gpu['driver']}", "gpu": gpu}


def probe(force_cpu: bool = False, run=subprocess.run) -> dict:
    """O retrato do computador + o motor recomendado (vai no heartbeat e na tela de configurações)."""
    gpus = nvidia_gpus(run)
    return {
        "os": f"{platform.system()} {platform.release()}",
        "machine": platform.machine(),
        "cpu_cores": os.cpu_count(),
        "ram_mb": _ram_mb(),
        "gpus": gpus,
        **choose_engine(gpus, force_cpu),
    }


_summary_cache: dict | None = None


def summary() -> dict:
    """O resumo que o agente manda ao servidor no heartbeat (calculado uma vez por execução; sem nomes de usuário nem caminhos)."""
    global _summary_cache
    if _summary_cache is None:
        data = probe()
        gpu = data.get("gpu") or {}
        _summary_cache = {"engine": data["engine"], "reason": data["reason"], "cpu_cores": data["cpu_cores"], "ram_mb": data["ram_mb"],
                          "gpu": gpu.get("name"), "driver": gpu.get("driver"), "vram_mb": gpu.get("vram_mb"), "os": data["os"]}
    return _summary_cache


def gpu_selftest() -> dict:
    """Roda DENTRO do motor instalado: confere de verdade se a GPU calcula (uma convolução pequena). Nunca levanta exceção:
    devolve {"ok": bool, "device": "cuda"|"cpu", "detail": ...}."""
    try:
        import torch
    except ImportError as exc:
        return {"ok": False, "device": "cpu", "detail": f"torch não está instalado ({exc})"}
    if not torch.cuda.is_available():
        return {"ok": False, "device": "cpu", "detail": "o torch não enxerga uma GPU CUDA"}
    try:
        index = torch.cuda.current_device()
        capability = torch.cuda.get_device_capability(index)
        arch = f"sm_{capability[0]}{capability[1]}"
        if arch not in torch.cuda.get_arch_list():
            return {"ok": False, "device": "cpu", "detail": f"este torch não tem kernels para a placa ({arch}); arquiteturas: {', '.join(torch.cuda.get_arch_list())}"}
        x = torch.randn(1, 2, 4096, device="cuda")
        weight = torch.randn(4, 2, 9, device="cuda")
        y = torch.nn.functional.conv1d(x, weight)
        torch.cuda.synchronize()
        if not bool(torch.isfinite(y).all()):
            return {"ok": False, "device": "cpu", "detail": "a GPU devolveu números inválidos"}
        return {"ok": True, "device": "cuda", "detail": torch.cuda.get_device_name(index)}
    except Exception as exc:  # noqa: BLE001 - qualquer falha do CUDA significa "use a CPU"
        return {"ok": False, "device": "cpu", "detail": f"{type(exc).__name__}: {exc}"}


def main(argv: list[str] | None = None) -> int:
    """`python -m singalong_worker.hardware [--selftest] [--cpu]` → JSON no stdout."""
    args = sys.argv[1:] if argv is None else argv
    data = probe(force_cpu="--cpu" in args)
    if "--selftest" in args:
        data["selftest"] = gpu_selftest()
    print(json.dumps(data, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
