"""Verificação do hardware: escolhe o motor pelas especificações e nunca quebra quando falta nvidia-smi ou torch."""
import subprocess
import unittest
from unittest import mock

from singalong_worker import hardware


def smi(*lines, code=0):
    def run(cmd, **kwargs):
        return subprocess.CompletedProcess(cmd, code, stdout="\n".join(lines) + "\n", stderr="")

    return run


def gpu(name="NVIDIA GeForce RTX 3060", driver="552.22", vram=12288, compute="8.6"):
    return {"name": name, "driver": driver, "vram_mb": vram, "compute": compute, "vendor": "nvidia", "engine": "cu121"}


def amd(name="AMD Radeon RX 7900 XTX", vram=24576, compute="gfx1100", access=True):
    return {"name": name, "driver": "amdgpu", "vram_mb": vram, "compute": compute, "vendor": "amd", "engine": "rocm6.2", "access": access}


APPLE = {"name": "Apple M2", "driver": "Metal", "vram_mb": 16384, "compute": "mps", "vendor": "apple", "engine": "mps"}


def write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def fake_sysfs(root, cards, archs=(), extra_cpu_node=True):
    """Um /sys de mentira: placas em class/drm e os nós do kfd (o nó 0 é o processador, com gfx_target_version 0)."""
    for i, (vendor, name, vram) in enumerate(cards):
        device = root / "class" / "drm" / f"card{i}" / "device"
        write(device / "vendor", vendor + "\n")
        if name:
            write(device / "product_name", name + "\n")
        if vram is not None:
            write(device / "mem_info_vram_total", f"{vram}\n")
    write(root / "class" / "drm" / "card0-HDMI-A-1" / "status", "connected\n")  # entrada que não é uma placa: tem de ser ignorada
    nodes = root / "class" / "kfd" / "kfd" / "topology" / "nodes"
    index = 0
    if extra_cpu_node:
        write(nodes / "0" / "properties", "cpu_cores_count 16\ngfx_target_version 0\n")
        index = 1
    for version in archs:
        write(nodes / str(index) / "properties", f"simd_count 96\ngfx_target_version {version}\n")
        index += 1


class ChooseEngineTests(unittest.TestCase):
    def test_modern_nvidia_gets_cuda(self):
        decision = hardware.choose_engine([gpu()])
        self.assertEqual(decision["engine"], "cu121")
        self.assertIn("RTX 3060", decision["reason"])

    def test_no_gpu_is_cpu(self):
        self.assertEqual(hardware.choose_engine([])["engine"], "cpu")

    def test_mac_without_apple_chip_and_other_systems_say_why_it_is_the_cpu(self):
        with mock.patch.object(hardware.platform, "system", return_value="Darwin"):
            decision = hardware.choose_engine([])
        self.assertEqual(decision["engine"], "cpu")
        self.assertIn("Mac Intel", decision["reason"])
        with mock.patch.object(hardware.platform, "system", return_value="Linux"):
            self.assertIn("nenhuma placa de vídeo compatível", hardware.choose_engine([])["reason"])

    def test_the_apple_gpu_is_never_chosen_by_itself_but_stays_in_the_options(self):
        decision = hardware.choose_engine([APPLE])
        self.assertEqual(decision["engine"], "cpu")  # o automático no Mac é a CPU: a GPU da Apple ainda não foi medida
        self.assertIn("beta", decision["reason"])
        self.assertEqual(decision["gpu"]["engine"], "mps")  # a tela de configurações oferece a opção

    def test_supported_amd_card_gets_rocm(self):
        decision = hardware.choose_engine([amd()])
        self.assertEqual(decision["engine"], "rocm6.2")
        self.assertIn("gfx1100", decision["reason"])
        self.assertEqual(hardware.choose_engine([amd(name="AMD Radeon RX 6800", compute="gfx1030")])["engine"], "rocm6.2")

    def test_amd_card_that_rocm_cannot_use_falls_back_and_says_why(self):
        unsupported = hardware.choose_engine([amd(name="AMD Radeon RX 6600", compute="gfx1032")])
        self.assertEqual(unsupported["engine"], "cpu")
        self.assertIn("gfx1032", unsupported["reason"])
        self.assertIn("suporte oficial", unsupported["reason"])
        self.assertIn("desconhecida", hardware.choose_engine([amd(compute="")])["reason"])
        self.assertIn("MB de memória", hardware.choose_engine([amd(vram=2048)])["reason"])
        no_access = hardware.choose_engine([amd(access=False)])
        self.assertEqual(no_access["engine"], "cpu")
        self.assertIn("grupos render e video", no_access["reason"])

    def test_nvidia_wins_when_there_is_also_another_card(self):
        self.assertEqual(hardware.choose_engine([amd(), gpu()])["engine"], "cu121")  # notebook com a placa da AMD integrada e uma NVIDIA

    def test_force_cpu_beats_amd_and_apple(self):
        self.assertEqual(hardware.choose_engine([amd()], force_cpu=True)["engine"], "cpu")
        self.assertEqual(hardware.choose_engine([APPLE], force_cpu=True)["reason"], "CPU forçada nas configurações")

    def test_old_driver_is_cpu_and_says_to_update(self):
        decision = hardware.choose_engine([gpu(driver="470.99")])
        self.assertEqual(decision["engine"], "cpu")
        self.assertIn("driver", decision["reason"])

    def test_blackwell_has_no_kernels_yet(self):
        decision = hardware.choose_engine([gpu(name="NVIDIA GeForce RTX 5070", compute="12.0")])
        self.assertEqual(decision["engine"], "cpu")
        self.assertIn("suporte", decision["reason"])

    def test_old_maxwell_is_still_ok_and_kepler_is_not(self):
        self.assertEqual(hardware.choose_engine([gpu(compute="5.2")])["engine"], "cu121")
        self.assertEqual(hardware.choose_engine([gpu(compute="3.5")])["engine"], "cpu")

    def test_too_little_memory_is_cpu(self):
        self.assertEqual(hardware.choose_engine([gpu(vram=2048)])["engine"], "cpu")

    def test_force_cpu_wins(self):
        self.assertEqual(hardware.choose_engine([gpu()], force_cpu=True)["engine"], "cpu")

    def test_picks_the_card_with_the_most_memory(self):
        decision = hardware.choose_engine([gpu(name="Pequena", vram=4096), gpu(name="Grande", vram=24576)])
        self.assertEqual(decision["gpu"]["name"], "Grande")

    def test_driver_comparison_is_numeric_not_textual(self):
        self.assertEqual(hardware.choose_engine([gpu(driver="1000.1")])["engine"], "cu121")
        self.assertEqual(hardware.choose_engine([gpu(driver="527.41")])["engine"], "cu121")
        self.assertEqual(hardware.choose_engine([gpu(driver="527.40")])["engine"], "cpu")


class DetectionTests(unittest.TestCase):
    def test_parses_nvidia_smi(self):
        with mock.patch("shutil.which", return_value="nvidia-smi"):
            gpus = hardware.nvidia_gpus(smi("NVIDIA GeForce RTX 3060, 552.22, 12288, 8.6"))
        self.assertEqual(gpus, [gpu()])

    def test_missing_nvidia_smi_means_no_gpu(self):
        with mock.patch("shutil.which", return_value=None), mock.patch("os.path.exists", return_value=False):
            self.assertEqual(hardware.nvidia_gpus(), [])

    def test_failing_nvidia_smi_means_no_gpu(self):
        with mock.patch("shutil.which", return_value="nvidia-smi"):
            self.assertEqual(hardware.nvidia_gpus(smi("erro", code=9)), [])
            self.assertEqual(hardware.nvidia_gpus(mock.Mock(side_effect=OSError("sem permissão"))), [])

    def test_garbage_lines_are_skipped(self):
        with mock.patch("shutil.which", return_value="nvidia-smi"):
            self.assertEqual(hardware.nvidia_gpus(smi("lixo", "NVIDIA X, 552.22, [N/A], 8.6")), [gpu(name="NVIDIA X", vram=0)])

    def test_probe_and_summary_have_no_paths_or_user_names(self):
        with mock.patch("shutil.which", return_value="nvidia-smi"):
            data = hardware.probe(run=smi("NVIDIA GeForce RTX 3060, 552.22, 12288, 8.6"))
        self.assertEqual(data["engine"], "cu121")
        self.assertGreaterEqual(data["cpu_cores"], 1)
        with mock.patch.object(hardware, "_summary_cache", None), mock.patch.object(hardware, "probe", return_value=data):
            summary = hardware.summary()
        self.assertEqual(set(summary), {"engine", "reason", "cpu_cores", "ram_mb", "gpu", "driver", "vram_mb", "os"})


class AmdAndAppleDetectionTests(unittest.TestCase):
    def setUp(self):
        import tempfile
        from pathlib import Path

        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)

    def test_gfx_names_from_the_kfd_target_version(self):
        self.assertEqual(hardware._gfx_id(110000), "gfx1100")  # RX 7900
        self.assertEqual(hardware._gfx_id(100300), "gfx1030")  # RX 6800
        self.assertEqual(hardware._gfx_id(90010), "gfx90a")  # Instinct MI210
        self.assertEqual(hardware._gfx_id(90402), "gfx942")  # MI300
        self.assertIsNone(hardware._gfx_id(0))  # o nó do processador

    def test_reads_the_amd_card_from_sysfs(self):
        fake_sysfs(self.root, [("0x1002", "AMD Radeon RX 7900 XTX", 25753026560)], archs=[110000])
        kfd = self.root / "kfd"
        kfd.write_text("")
        with mock.patch.object(hardware.platform, "system", return_value="Linux"):
            gpus = hardware.amd_gpus(self.root, kfd)
        self.assertEqual(gpus, [amd(vram=24560)])

    def test_ignores_other_vendors_and_works_without_kfd_or_amdgpu(self):
        fake_sysfs(self.root, [("0x10de", "NVIDIA", 8589934592), ("0x8086", None, None)], archs=[])
        with mock.patch.object(hardware.platform, "system", return_value="Linux"):
            self.assertEqual(hardware.amd_gpus(self.root, self.root / "nao-existe"), [])
            self.assertEqual(hardware.amd_gpus(self.root / "vazio", self.root / "nao-existe"), [])  # sem o /sys do amdgpu
        with mock.patch.object(hardware.platform, "system", return_value="Windows"):
            self.assertEqual(hardware.amd_gpus(self.root), [])  # só existe no Linux

    def test_without_the_kfd_device_the_card_is_seen_but_has_no_access(self):
        fake_sysfs(self.root, [("0x1002", "AMD Radeon RX 7800 XT", 17163091968)], archs=[110100])
        with mock.patch.object(hardware.platform, "system", return_value="Linux"):
            (card,) = hardware.amd_gpus(self.root, self.root / "sem-kfd")
        self.assertFalse(card["access"])
        self.assertEqual(hardware.choose_engine([card])["engine"], "cpu")

    def test_apple_silicon_only_on_a_mac_with_the_apple_chip(self):
        with mock.patch.object(hardware.platform, "system", return_value="Darwin"), mock.patch.object(hardware.platform, "machine", return_value="arm64"):
            with mock.patch.object(hardware, "_ram_mb", return_value=16384):
                (chip,) = hardware.apple_gpus(smi("Apple M2"))
        self.assertEqual((chip["name"], chip["engine"], chip["vram_mb"]), ("Apple M2", "mps", 16384))
        with mock.patch.object(hardware.platform, "system", return_value="Darwin"), mock.patch.object(hardware.platform, "machine", return_value="x86_64"):
            self.assertEqual(hardware.apple_gpus(smi("Intel")), [])  # Mac Intel
        with mock.patch.object(hardware.platform, "system", return_value="Linux"):
            self.assertEqual(hardware.apple_gpus(smi("x")), [])


class SelftestTests(unittest.TestCase):
    def test_rocm_needs_the_rocm_build_of_torch_and_skips_the_cuda_architecture_check(self):
        fake = mock.Mock()
        fake.cuda.is_available.return_value = True
        fake.version.hip = None  # um torch de CUDA
        with mock.patch.dict("sys.modules", {"torch": fake}):
            self.assertIn("não é o do ROCm", hardware.gpu_selftest("rocm6.2")["detail"])
        fake.version.hip = "6.2.41133"
        fake.cuda.get_device_name.return_value = "AMD Radeon RX 7900 XTX"
        fake.isfinite.return_value.all.return_value = True
        with mock.patch.dict("sys.modules", {"torch": fake}):
            result = hardware.gpu_selftest("rocm6.2")
        self.assertEqual((result["ok"], result["device"]), (True, "cuda"))  # no torch a placa AMD também se chama "cuda"
        fake.cuda.get_device_capability.assert_not_called()  # sem o sm_XX do CUDA

    def test_rocm_without_a_visible_gpu_says_so(self):
        fake = mock.Mock()
        fake.cuda.is_available.return_value = False
        with mock.patch.dict("sys.modules", {"torch": fake}):
            self.assertIn("GPU AMD", hardware.gpu_selftest("rocm6.2")["detail"])

    def test_mps_must_be_available_and_compute_the_conv_and_the_fft(self):
        fake = mock.MagicMock()
        fake.backends.mps.is_built.return_value = True
        fake.backends.mps.is_available.return_value = False
        with mock.patch.dict("sys.modules", {"torch": fake}):
            result = hardware.gpu_selftest("mps")
        self.assertEqual((result["ok"], result["device"]), (False, "cpu"))
        self.assertIn("Metal", result["detail"])
        fake.backends.mps.is_available.return_value = True
        fake.isfinite.return_value.all.return_value = True
        with mock.patch.dict("sys.modules", {"torch": fake}):
            ok = hardware.gpu_selftest("mps")
        self.assertEqual((ok["ok"], ok["device"]), (True, "mps"))
        fake.stft.assert_called_once()  # o Demucs usa a FFT com números complexos: é ela que costuma faltar no Metal

    def test_an_mps_error_falls_back_to_the_cpu(self):
        fake = mock.MagicMock()
        fake.backends.mps.is_built.return_value = True
        fake.backends.mps.is_available.return_value = True
        fake.stft.side_effect = NotImplementedError("The operator aten::stft is not currently implemented for the MPS device")
        with mock.patch.dict("sys.modules", {"torch": fake}):
            result = hardware.gpu_selftest("mps")
        self.assertEqual((result["ok"], result["device"]), (False, "cpu"))
        self.assertIn("aten::stft", result["detail"])

    def test_without_torch_it_reports_instead_of_raising(self):
        with mock.patch.dict("sys.modules", {"torch": None}):
            result = hardware.gpu_selftest()
        self.assertFalse(result["ok"])
        self.assertEqual(result["device"], "cpu")

    def test_without_cuda_it_falls_back_to_cpu(self):
        fake = mock.Mock()
        fake.cuda.is_available.return_value = False
        with mock.patch.dict("sys.modules", {"torch": fake}):
            result = hardware.gpu_selftest()
        self.assertEqual((result["ok"], result["device"]), (False, "cpu"))

    def test_architecture_without_kernels_is_detected(self):
        fake = mock.Mock()
        fake.cuda.is_available.return_value = True
        fake.cuda.get_device_capability.return_value = (12, 0)
        fake.cuda.get_arch_list.return_value = ["sm_50", "sm_86", "sm_90"]
        with mock.patch.dict("sys.modules", {"torch": fake}):
            result = hardware.gpu_selftest()
        self.assertFalse(result["ok"])
        self.assertIn("sm_120", result["detail"])

    def test_a_cuda_error_during_the_test_falls_back(self):
        fake = mock.Mock()
        fake.cuda.is_available.return_value = True
        fake.cuda.get_device_capability.return_value = (8, 6)
        fake.cuda.get_arch_list.return_value = ["sm_86"]
        fake.randn.side_effect = RuntimeError("CUDA error: no kernel image")
        with mock.patch.dict("sys.modules", {"torch": fake}):
            result = hardware.gpu_selftest()
        self.assertFalse(result["ok"])
        self.assertIn("no kernel image", result["detail"])


if __name__ == "__main__":
    unittest.main()
