"""The hardware check: picks the engine (an NVIDIA GPU with CUDA 12.1, an AMD GPU with ROCm 6.2, Apple's GPU through Metal, or the
CPU) and checks that the GPU really works.

It uses only the standard library: it runs before torch exists (the installer decides which torch to download) and again after,
inside the installed engine, with `gpu_selftest` (a small convolution on the GPU). Any failure falls back to the CPU, with the reason.

Engines: "cu121" (NVIDIA), "rocm6.2" (AMD, Linux only), "mps" (Apple Silicon, optional: the automatic choice on a Mac is still the
CPU) and "cpu"."""
import json
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

ACCELERATED = ("cu121", "rocm6.2", "mps")

# The minimum CUDA 12.1 driver (Windows 527.41, Linux 525.60). Below it, the cu121 torch does not see the GPU.
MIN_DRIVER = (527, 41)
# The compute capabilities torch 2.5.1/cu121 ships kernels for (Maxwell sm_50 to Ada/Hopper sm_90). Blackwell (RTX 50, 12.0) is left out.
SUPPORTED_COMPUTE = ((5, 0), (9, 0))
MIN_VRAM_MB = 3000  # Demucs needs ~3 GB to separate a song without running out
# The AMD architectures torch 2.5.1/rocm6.2 ships kernels for (Instinct gfx900-gfx942, RDNA2 gfx1030, RDNA3 gfx1100-1102).
# Others (RX 6600, RX 7600...) only work with an unofficial environment variable trick: they stay on the CPU, with the reason.
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
    """The NVIDIA cards nvidia-smi sees (empty if there is no card or driver)."""
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
    """kfd's `gfx_target_version` (decimal: 110000, 100300, 90010...) as the architecture's name (gfx1100, gfx1030, gfx90a)."""
    if target_version <= 0:
        return None  # the processor's node, not a GPU's
    major, minor, step = target_version // 10000, (target_version // 100) % 100, target_version % 100
    return f"gfx{major}{minor:x}{step:x}"


def amd_gpus(sysfs: Path = Path("/sys"), kfd: Path = Path("/dev/kfd")) -> list[dict]:
    """The AMD cards the Linux kernel sees (no tools: it reads /sys, which exists with the amdgpu driver). Linux only.
    `compute` is the architecture (gfx1100...); `access` says whether this user may use /dev/kfd (it needs the render and video groups)."""
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


def apple_gpus(run=subprocess.run, env=os.environ) -> list[dict]:
    """Apple Silicon's GPU (unified memory: the "VRAM" is the Mac's memory). Only on macOS with an Apple chip, and **turned off**.

    Measured on the CI's macOS (real Metal, torch 2.5.1): the small self-test passes, but Demucs fails to separate a song with
    "NotImplementedError: Output channels > 65536 not supported at the MPS device" (the PYTORCH_ENABLE_MPS_FALLBACK detour does not cover it).
    With no gain (and the separation redone on the CPU for every song), the option is not offered. `SINGALONG_APPLE_GPU=1` turns it on, for whoever
    wants to measure again with another torch version (the CI job takes this measurement on every change)."""
    if env.get("SINGALONG_APPLE_GPU") != "1":
        return []
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
    """Decides the engine: {"engine": "cu121"|"rocm6.2"|"cpu", "reason": ..., "gpu": {...}|None}. The decision goes by the specs only;
    the real test (`gpu_selftest`) confirms it after installing and may send it back to the CPU. Apple's GPU (mps) is never picked
    by itself: it shows among the options, but the automatic choice on a Mac is the CPU (it is turned off: see `apple_gpus`)."""
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
            if platform.machine() == "arm64":
                return {"engine": "cpu", "reason": "Mac com chip da Apple: o motor roda na CPU (a GPU da Apple ainda não separa as músicas: o Demucs do torch 2.5.1 falha no Metal)", "gpu": None}
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
    """The AMD card through ROCm 6.2 (Linux only): it needs an architecture with kernels in torch, memory and access to /dev/kfd."""
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
    """The computer's snapshot + the recommended engine (sent in the heartbeat and shown on the settings screen)."""
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
    """The summary the agent sends to the server in the heartbeat (computed once per run; no user names or paths)."""
    global _summary_cache
    if _summary_cache is None:
        data = probe()
        gpu = data.get("gpu") or {}
        _summary_cache = {"engine": data["engine"], "reason": data["reason"], "cpu_cores": data["cpu_cores"], "ram_mb": data["ram_mb"],
                          "gpu": gpu.get("name"), "driver": gpu.get("driver"), "vram_mb": gpu.get("vram_mb"), "os": data["os"]}
    return _summary_cache


def gpu_selftest(engine: str = "cu121") -> dict:
    """Runs INSIDE the installed engine: really checks that the GPU computes (a small convolution). It never raises:
    returns {"ok": bool, "device": "cuda"|"mps"|"cpu", "detail": ...}. `engine` says which GPU to expect: cu121 (NVIDIA), rocm6.2 (AMD, which
    torch also calls "cuda") or mps (Apple, which must also compute the FFT Demucs uses)."""
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
    """Apple's GPU: Metal is available, a convolution computes, and so does the FFT with complex numbers (which Demucs uses)."""
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
    """`python -m singalong_worker.hardware [--selftest] [--cpu]` → JSON on stdout."""
    args = sys.argv[1:] if argv is None else argv
    data = probe(force_cpu="--cpu" in args)
    if "--selftest" in args:
        data["selftest"] = gpu_selftest(data["engine"] if data["engine"] in ACCELERATED else "cu121")
    print(json.dumps(data, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
