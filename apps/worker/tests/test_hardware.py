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
    return {"name": name, "driver": driver, "vram_mb": vram, "compute": compute}


class ChooseEngineTests(unittest.TestCase):
    def test_modern_nvidia_gets_cuda(self):
        decision = hardware.choose_engine([gpu()])
        self.assertEqual(decision["engine"], "cu121")
        self.assertIn("RTX 3060", decision["reason"])

    def test_no_gpu_is_cpu(self):
        self.assertEqual(hardware.choose_engine([])["engine"], "cpu")

    def test_macos_runs_on_the_cpu_for_now_and_says_so(self):
        with mock.patch.object(hardware.platform, "system", return_value="Darwin"):
            decision = hardware.choose_engine([])
        self.assertEqual(decision["engine"], "cpu")
        self.assertIn("macOS", decision["reason"])
        with mock.patch.object(hardware.platform, "system", return_value="Linux"):
            self.assertIn("nenhuma placa NVIDIA", hardware.choose_engine([])["reason"])  # fora do Mac a mensagem continua a de sempre

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


class SelftestTests(unittest.TestCase):
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
