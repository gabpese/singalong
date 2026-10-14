"""Verificação do hardware: escolhe o motor (GPU NVIDIA com CUDA 12.1, GPU AMD com ROCm 6.2, GPU da Apple pelo Metal ou CPU) e
confere se a GPU funciona de verdade.

Usa só a biblioteca padrão: roda antes de o torch existir (o instalador decide qual torch baixar) e de novo depois, dentro do
motor instalado, com `gpu_selftest` (uma convolução pequena na GPU). Qualquer falha cai para a CPU, com o motivo.

Motores: "cu121" (NVIDIA), "rocm6.2" (AMD, só Linux), "mps" (Apple Silicon, opcional: o automático no Mac continua sendo a CPU) e "cpu"."""
import json
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

ACCELERATED = ("cu121", "rocm6.2", "mps")

# Driver mínimo do CUDA 12.1 (Windows 527.41, Linux 525.60). Abaixo disso o torch cu121 não enxerga a GPU.
MIN_DRIVER = (527, 41)
# Capacidade de computação que o torch 2.5.1/cu121 traz kernels (Maxwell sm_50 até Ada/Hopper sm_90). A Blackwell (RTX 50, 12.0) fica de fora.
SUPPORTED_COMPUTE = ((5, 0), (9, 0))
MIN_VRAM_MB = 3000  # o Demucs precisa de ~3 GB para separar uma música sem estourar
# Arquiteturas AMD para as quais o torch 2.5.1/rocm6.2 traz kernels (Instinct gfx900-gfx942, RDNA2 gfx1030, RDNA3 gfx1100-1102).
# Outras (RX 6600, RX 7600...) só funcionam com um truque de variável de ambiente que não é oficial: ficam na CPU, com o motivo.
SUPPORTED_GFX = ("gfx900", "gfx906", "gfx908", "gfx90a", "gfx942", "gfx1030", "gfx1100", "gfx1101", "gfx1102")


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
        gpus.append({"name": name, "driver": driver, "vram_mb": vram, "compute": compute, "vendor": "nvidia", "engine": "cu121"})
    return gpus


def _read(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        return None


def _gfx_id(target_version: int) -> str | None:
    """O `gfx_target_version` do kfd (decimal: 110000, 100300, 90010...) como o nome da arquitetura (gfx1100, gfx1030, gfx90a)."""
    if target_version <= 0:
        return None  # nó do processador, não de uma GPU
    major, minor, step = target_version // 10000, (target_version // 100) % 100, target_version % 100
    return f"gfx{major}{minor:x}{step:x}"


def amd_gpus(sysfs: Path = Path("/sys"), kfd: Path = Path("/dev/kfd")) -> list[dict]:
    """As placas AMD vistas pelo kernel do Linux (sem ferramentas: lê o /sys, que existe com o driver amdgpu). Só no Linux.
    `compute` é a arquitetura (gfx1100...); `access` diz se este usuário pode usar o /dev/kfd (precisa dos grupos render e video)."""
    if platform.system() != "Linux":
        return []
    archs = []
    nodes = sysfs / "class" / "kfd" / "kfd" / "topology" / "nodes"
    for node in sorted(nodes.glob("*")) if nodes.is_dir() else []:
        for line in (_read(node / "properties") or "").splitlines():
            if line.startswith("gfx_target_version"):
                try:
                    gfx = _gfx_id(int(line.split()[1]))
                except (ValueError, IndexError):
                    gfx = None
                if gfx:
                    archs.append(gfx)
    cards = []
    drm = sysfs / "class" / "drm"
    for card in sorted(drm.glob("card[0-9]*")) if drm.is_dir() else []:
        device = card / "device"
        if _read(device / "vendor") != "0x1002":  # 0x1002 = AMD
            continue
        total = _read(device / "mem_info_vram_total")
        cards.append({"name": _read(device / "product_name") or "Placa de vídeo AMD", "vram_mb": int(total) // 2**20 if total and total.isdigit() else 0})
    access = kfd.exists() and os.access(kfd, os.R_OK | os.W_OK)
    return [
        {"name": card["name"], "driver": "amdgpu", "vram_mb": card["vram_mb"], "compute": archs[i] if i < len(archs) else "", "vendor": "amd", "engine": "rocm6.2", "access": access}
        for i, card in enumerate(cards)
    ]


def apple_gpus(run=subprocess.run) -> list[dict]:
    """A GPU do Apple Silicon (memória unificada: a "VRAM" é a memória do Mac). Só no macOS com chip da Apple."""
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        return []
    name = (_run(["sysctl", "-n", "machdep.cpu.brand_string"], run=run) or "").strip() or "Apple Silicon"
    return [{"name": name, "driver": "Metal", "vram_mb": _ram_mb() or 0, "compute": "mps", "vendor": "apple", "engine": "mps"}]


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
    """Decide o motor: {"engine": "cu121"|"rocm6.2"|"cpu", "reason": ..., "gpu": {...}|None}. A decisão é só pelas especificações;
    o teste de verdade (`gpu_selftest`) confirma depois de instalar e pode devolver para a CPU. A GPU da Apple (mps) nunca é escolhida
    sozinha: aparece nas opções, mas o automático no Mac é a CPU (ela ainda não foi medida e é a única que não é a prova de falhas)."""
    if force_cpu:
        return {"engine": "cpu", "reason": "CPU forçada nas configurações", "gpu": None}
    nvidia = [g for g in gpus if g.get("vendor", "nvidia") == "nvidia"]
    if not nvidia:
        amd = [g for g in gpus if g.get("vendor") == "amd"]
        apple = [g for g in gpus if g.get("vendor") == "apple"]
        if amd:
            return _choose_amd(amd)
        if apple:
            return {"engine": "cpu", "reason": "Mac: o automático usa a CPU; a GPU da Apple (Metal) é opcional e está em beta nas configurações", "gpu": apple[0]}
        if platform.system() == "Darwin":
            return {"engine": "cpu", "reason": "macOS sem chip da Apple (Mac Intel): o motor roda na CPU", "gpu": None}
        return {"engine": "cpu", "reason": "nenhuma placa de vídeo compatível (NVIDIA ou AMD) encontrada", "gpu": None}
    gpus = nvidia
    gpu = max(gpus, key=lambda g: g["vram_mb"])
    if _numbers(gpu["driver"]) < MIN_DRIVER:
        return {"engine": "cpu", "reason": f"driver da NVIDIA {gpu['driver']} é antigo para o CUDA 12.1 (precisa de {'.'.join(map(str, MIN_DRIVER))} ou mais novo): atualize o driver", "gpu": gpu}
    compute = _numbers(gpu["compute"])[:2]
    if compute and not (SUPPORTED_COMPUTE[0] <= compute <= SUPPORTED_COMPUTE[1]):
        return {"engine": "cpu", "reason": f"a placa {gpu['name']} (capacidade {gpu['compute']}) ainda não tem suporte no motor atual", "gpu": gpu}
    if gpu["vram_mb"] < MIN_VRAM_MB:
        return {"engine": "cpu", "reason": f"a placa tem só {gpu['vram_mb']} MB de memória (mínimo {MIN_VRAM_MB} MB)", "gpu": gpu}
    return {"engine": "cu121", "reason": f"{gpu['name']} com driver {gpu['driver']}", "gpu": gpu}


def _choose_amd(amd: list[dict]) -> dict:
    """A placa AMD pelo ROCm 6.2 (só Linux): precisa de uma arquitetura com kernels no torch, de memória e de acesso ao /dev/kfd."""
    gpu = max(amd, key=lambda g: g["vram_mb"])
    if gpu.get("compute") not in SUPPORTED_GFX:
        arch = gpu.get("compute") or "desconhecida"
        return {"engine": "cpu", "reason": f"a placa {gpu['name']} (arquitetura {arch}) não tem suporte oficial no ROCm 6.2: usando a CPU", "gpu": gpu}
    if gpu["vram_mb"] < MIN_VRAM_MB:
        return {"engine": "cpu", "reason": f"a placa tem só {gpu['vram_mb']} MB de memória (mínimo {MIN_VRAM_MB} MB)", "gpu": gpu}
    if not gpu.get("access", True):
        return {"engine": "cpu", "reason": "sem acesso à placa AMD (/dev/kfd): coloque o seu usuário nos grupos render e video e entre de novo no Linux", "gpu": gpu}
    return {"engine": "rocm6.2", "reason": f"{gpu['name']} ({gpu['compute']}) pelo ROCm 6.2", "gpu": gpu}


def probe(force_cpu: bool = False, run=subprocess.run) -> dict:
    """O retrato do computador + o motor recomendado (vai no heartbeat e na tela de configurações)."""
    gpus = nvidia_gpus(run) + amd_gpus() + apple_gpus(run)
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


def gpu_selftest(engine: str = "cu121") -> dict:
    """Roda DENTRO do motor instalado: confere de verdade se a GPU calcula (uma convolução pequena). Nunca levanta exceção:
    devolve {"ok": bool, "device": "cuda"|"mps"|"cpu", "detail": ...}. `engine` diz qual GPU esperar: cu121 (NVIDIA), rocm6.2 (AMD, que
    no torch também se chama "cuda") ou mps (Apple, que ainda precisa calcular a FFT que o Demucs usa)."""
    try:
        import torch
    except ImportError as exc:
        return {"ok": False, "device": "cpu", "detail": f"torch não está instalado ({exc})"}
    if engine == "mps":
        return _selftest_mps(torch)
    if not torch.cuda.is_available():
        return {"ok": False, "device": "cpu", "detail": "o torch não enxerga uma GPU AMD (ROCm)" if engine == "rocm6.2" else "o torch não enxerga uma GPU CUDA"}
    try:
        index = torch.cuda.current_device()
        if engine == "rocm6.2":
            if not getattr(torch.version, "hip", None):
                return {"ok": False, "device": "cpu", "detail": "este torch não é o do ROCm"}
        else:
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
    except Exception as exc:  # noqa: BLE001 - qualquer falha da GPU significa "use a CPU"
        return {"ok": False, "device": "cpu", "detail": f"{type(exc).__name__}: {exc}"}


def _selftest_mps(torch) -> dict:
    """A GPU da Apple: o Metal está disponível, uma convolução calcula e a FFT com números complexos (que o Demucs usa) também."""
    try:
        if not (torch.backends.mps.is_built() and torch.backends.mps.is_available()):
            return {"ok": False, "device": "cpu", "detail": "o torch não enxerga a GPU da Apple (Metal)"}
        x = torch.randn(1, 2, 4096, device="mps")
        y = torch.nn.functional.conv1d(x, torch.randn(4, 2, 9, device="mps"))
        spec = torch.stft(x[0, 0], n_fft=512, hop_length=128, window=torch.hann_window(512, device="mps"), return_complex=True)
        torch.mps.synchronize()
        if not (bool(torch.isfinite(y).all()) and bool(torch.isfinite(torch.view_as_real(spec)).all())):
            return {"ok": False, "device": "cpu", "detail": "a GPU da Apple devolveu números inválidos"}
        return {"ok": True, "device": "mps", "detail": "GPU da Apple (Metal)"}
    except Exception as exc:  # noqa: BLE001 - qualquer falha do Metal significa "use a CPU"
        return {"ok": False, "device": "cpu", "detail": f"{type(exc).__name__}: {exc}"}


def main(argv: list[str] | None = None) -> int:
    """`python -m singalong_worker.hardware [--selftest] [--cpu]` → JSON no stdout."""
    args = sys.argv[1:] if argv is None else argv
    data = probe(force_cpu="--cpu" in args)
    if "--selftest" in args:
        data["selftest"] = gpu_selftest(data["engine"] if data["engine"] in ACCELERATED else "cu121")
    print(json.dumps(data, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
