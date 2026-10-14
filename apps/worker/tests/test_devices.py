"""Qual dispositivo cada etapa usa conforme o motor instalado: a GPU da Apple separa a voz, mas o alinhamento da letra fica na CPU."""
import subprocess
import unittest
from pathlib import Path
from unittest import mock

from singalong_worker import devices


class EngineDeviceTests(unittest.TestCase):
    def test_only_the_apple_engine_asks_for_a_device(self):
        self.assertEqual(devices.engine_device({"SINGALONG_ENGINE": "mps"}), "mps")
        for engine in ("cu121", "rocm6.2", "cpu", ""):
            self.assertIsNone(devices.engine_device({"SINGALONG_ENGINE": engine}), engine)  # o Demucs escolhe (no ROCm a placa AMD é "cuda")
        self.assertIsNone(devices.engine_device({}))  # Docker e quem roda o worker à mão: nada muda

    def test_the_lyrics_alignment_never_goes_to_the_apple_gpu(self):
        self.assertEqual(devices.align_device("mps"), "cpu")
        self.assertEqual(devices.align_device("cuda"), "cuda")
        self.assertEqual(devices.align_device("cpu"), "cpu")
        self.assertIsNone(devices.align_device(None))


class SeparateFallbackTests(unittest.TestCase):
    def test_a_failure_on_the_apple_gpu_is_redone_on_the_cpu(self):
        calls = []

        def separate(audio, workdir, device, timeout):
            calls.append(device)
            if device == "mps":
                raise subprocess.CalledProcessError(1, "demucs")
            return ("instrumental.mp3", "vocals.mp3")

        result = devices.separate_with_fallback(separate, Path("a.mp3"), Path("w"), "mps", 60)
        self.assertEqual(result, ("instrumental.mp3", "vocals.mp3"))
        self.assertEqual(calls, ["mps", "cpu"])

    def test_other_devices_do_not_retry_and_a_timeout_is_not_retried_either(self):
        for device in ("cuda", "cpu", None):
            calls = []

            def failing(audio, workdir, dev, timeout, calls=calls):
                calls.append(dev)
                raise subprocess.CalledProcessError(1, "demucs")

            with self.assertRaises(subprocess.CalledProcessError):
                devices.separate_with_fallback(failing, Path("a.mp3"), Path("w"), device)
            self.assertEqual(calls, [device])

        def slow(audio, workdir, device, timeout):
            raise subprocess.TimeoutExpired("demucs", 60)

        with self.assertRaises(subprocess.TimeoutExpired):
            devices.separate_with_fallback(slow, Path("a.mp3"), Path("w"), "mps")

    def test_success_on_the_apple_gpu_does_not_touch_the_cpu(self):
        separate = mock.Mock(return_value=("i", "v"))
        self.assertEqual(devices.separate_with_fallback(separate, Path("a"), Path("w"), "mps", None), ("i", "v"))
        separate.assert_called_once()
