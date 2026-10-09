import errno
import io
import json
import logging
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from singalong_worker import runner
from singalong_worker.errors import AUTO, MANUAL, NEVER, JobError, classify, format_duration
from singalong_worker.logsetup import JsonFormatter
from singalong_worker.pipeline import Limits, NeedsLyrics, check_disk, validate_video_info


class ClassifyTests(unittest.TestCase):
    def check(self, text, code, retry):
        err = classify(RuntimeError(text))
        self.assertEqual((err.code, err.retry), (code, retry), text)
        self.assertTrue(err.message.strip())
        return err

    def test_mensagens_reais_do_youtube(self):
        self.check("ERROR: [youtube] abc: Private video. Sign in if you've been granted access to this video", "private", NEVER)
        self.check("ERROR: [youtube] abc: Video unavailable", "unavailable", NEVER)
        self.check("ERROR: [youtube] abc: This video has been removed by the uploader", "unavailable", NEVER)
        self.check("ERROR: [youtube] abc: Video unavailable. This video contains content from SME, who has blocked it on copyright grounds", "copyright", NEVER)
        self.check("ERROR: [youtube] abc: The uploader has not made this video available in your country", "geo", NEVER)
        self.check("ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users.", "age", NEVER)
        self.check("ERROR: [youtube] abc: This live event will begin in 2 days.", "live", NEVER)
        self.check("ERROR: [youtube] abc: Join this channel to get access to members-only content", "members", NEVER)

    def test_cookies_vencidos_pedem_acao_manual(self):
        err = self.check("ERROR: [youtube] abc: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies", "cookies", MANUAL)
        self.assertIn("youtube_cookies.txt", err.message)

    def test_falhas_transitorias_sao_repetidas_sozinhas(self):
        self.check("ERROR: Unable to download video subtitles for 'en': HTTP Error 429: Too Many Requests", "rate_limited", AUTO)
        self.check("urlopen error [Errno -3] Temporary failure in name resolution", "network", AUTO)
        self.check("HTTP Error 503: Service Unavailable", "network", AUTO)
        self.check("The read operation timed out", "network", AUTO)

    def test_falhas_da_maquina(self):
        self.check("CUDA out of memory. Tried to allocate 1.2 GiB", "gpu_memory", MANUAL)
        self.check("[Errno 28] No space left on device", "disk_full", MANUAL)
        self.assertEqual(classify(OSError(errno.ENOSPC, "x")).code, "disk_full")
        self.assertEqual(classify(subprocess.TimeoutExpired("demucs", 5)).code, "timeout")
        self.assertEqual(classify(subprocess.CalledProcessError(1, "ffmpeg")).code, "audio")
        self.check("ERROR: Requested format is not available. Use --list-formats", "format", MANUAL)

    def test_desconhecido_nunca_vira_mensagem_vazia(self):
        err = classify(KeyError("algo"))
        self.assertEqual((err.code, err.retry), ("unknown", MANUAL))
        self.assertIn("KeyError", err.message)

    def test_job_error_passa_direto(self):
        original = JobError("too_long", "longo demais", NEVER)
        self.assertIs(classify(original), original)

    def test_prioridade_cookies_antes_de_privado(self):
        # "Sign in" aparece em vários erros; o de bot/cookies precisa vencer o genérico
        self.assertEqual(classify(RuntimeError("Sign in to confirm you're not a bot")).code, "cookies")

    def test_format_duration(self):
        self.assertEqual(format_duration(45), "45 s")
        self.assertEqual(format_duration(200), "3 min 20 s")
        self.assertEqual(format_duration(3900), "1 h 05 min")


class ValidateVideoTests(unittest.TestCase):
    def test_recusa_ao_vivo_privado_membros_e_longo_demais(self):
        for info, code in [
            ({"is_live": True}, "live"),
            ({"live_status": "is_upcoming"}, "live"),
            ({"availability": "private"}, "private"),
            ({"availability": "subscriber_only"}, "members"),
            ({"duration": 7200}, "too_long"),
        ]:
            with self.assertRaises(JobError, msg=str(info)) as ctx:
                validate_video_info(info, max_duration=900)
            self.assertEqual((ctx.exception.code, ctx.exception.retry), (code, NEVER))

    def test_mensagem_do_limite_diz_os_dois_tempos(self):
        with self.assertRaises(JobError) as ctx:
            validate_video_info({"duration": 7800}, 900)
        self.assertIn("2 h 10 min", ctx.exception.message)
        self.assertIn("15 min", ctx.exception.message)

    def test_aceita_o_normal_e_o_limite_exato_ou_desligado(self):
        validate_video_info({"duration": 222, "availability": "public", "is_live": False}, 900)
        validate_video_info({"duration": 900}, 900)  # exatamente no limite: passa
        validate_video_info({"duration": 99999}, None)  # limite desligado
        validate_video_info({}, 900)  # sem duração conhecida: não dá para recusar

    def test_limits_do_ambiente(self):
        with mock.patch.dict("os.environ", {"MAX_DURATION_SECONDS": "0", "MIN_FREE_GB": "5", "SEPARATE_TIMEOUT_SECONDS": "60"}):
            limits = Limits.from_env()
        self.assertEqual((limits.max_duration, limits.min_free_gb, limits.separate_timeout), (None, 5.0, 60.0))
        with mock.patch.dict("os.environ", {"MAX_DURATION_SECONDS": "lixo"}):
            self.assertEqual(Limits.from_env().max_duration, 900)  # valor inválido cai no padrão


class DiskGuardTests(unittest.TestCase):
    def test_sem_espaco_recusa_com_mensagem(self):
        usage = shutil._ntuple_diskusage(100 * 1024**3, 99 * 1024**3, int(0.5 * 1024**3))
        with tempfile.TemporaryDirectory() as d:
            check_disk(d, 0)  # desligado
            check_disk(d, 0.000001)  # sobra espaço
            with mock.patch.object(shutil, "disk_usage", return_value=usage):
                with self.assertRaises(JobError) as ctx:
                    check_disk(d, 2)
        self.assertEqual((ctx.exception.code, ctx.exception.retry), ("disk_full", MANUAL))
        self.assertIn("0.5 GB", ctx.exception.message)


class FakeRedis:
    """Só o que o runner usa: hash do job, contador e xack."""

    def __init__(self):
        self.hashes, self.acked, self.expires = {}, [], {}

    def hset(self, key, mapping):
        self.hashes.setdefault(key, {}).update(mapping)

    def hincrby(self, key, field, amount):
        h = self.hashes.setdefault(key, {})
        h[field] = int(h.get(field, 0)) + amount
        return h[field]

    def expire(self, key, ttl):
        self.expires[key] = ttl

    def xack(self, stream, group, msg_id):
        self.acked.append(msg_id)

    def job(self, vid="abcdefghijk"):
        return self.hashes[f"job:{vid}"]


class RunnerTests(unittest.TestCase):
    FIELDS = {"video_id": "abcdefghijk", "payload": json.dumps({"url": "https://youtu.be/abcdefghijk", "lyrics_source": "auto"})}

    def setUp(self):
        self.r = FakeRedis()
        self.settings = runner.Settings("redis://x", "/tmp", None, None, ["pt"], 1800, Path("/tmp/hb"), retry_wait=5)
        self.sleeps = []

    def handle(self, side_effect):
        with mock.patch.object(runner, "process", side_effect=side_effect) as proc:
            runner.handle(self.r, None, self.settings, "1-0", dict(self.FIELDS), sleep=self.sleeps.append)
        return proc

    def test_sucesso(self):
        proc = self.handle([{}])
        self.assertEqual(proc.call_count, 1)
        self.assertEqual(self.r.job()["status"], "ready")
        self.assertEqual(self.r.acked, ["1-0"])
        self.assertEqual(self.r.job()["error_code"], "")

    def test_falha_transitoria_tenta_de_novo_com_espera_crescente_e_termina_pronto(self):
        proc = self.handle([RuntimeError("HTTP Error 429"), RuntimeError("timed out"), {}])
        self.assertEqual(proc.call_count, 3)
        self.assertEqual(self.sleeps, [5, 20])  # 5 s e depois 4x
        self.assertEqual(self.r.job()["status"], "ready")

    def test_transitoria_que_nao_passa_falha_depois_das_tentativas_com_mensagem_clara(self):
        proc = self.handle([RuntimeError("HTTP Error 429")] * 5)
        self.assertEqual(proc.call_count, 3)  # WORKER_MAX_ATTEMPTS
        job = self.r.job()
        self.assertEqual((job["status"], job["error_code"], job["retry"]), ("failed", "rate_limited", "auto"))
        self.assertIn("limitou os pedidos", job["error"])
        self.assertEqual(self.r.acked, ["1-0"])

    def test_erro_sem_conserto_nao_repete(self):
        proc = self.handle([RuntimeError("ERROR: [youtube] x: Private video. Sign in if you've been granted access")])
        self.assertEqual(proc.call_count, 1)
        self.assertEqual(self.sleeps, [])
        job = self.r.job()
        self.assertEqual((job["status"], job["error_code"], job["retry"]), ("failed", "private", "never"))
        self.assertEqual(job["error"], "Este vídeo é privado. Escolha outro vídeo.")

    def test_job_error_do_pipeline_vira_a_mensagem_dele(self):
        self.handle([JobError("too_long", "O vídeo tem 2 h e o limite é 15 min.", NEVER)])
        job = self.r.job()
        self.assertEqual((job["error_code"], job["error"]), ("too_long", "O vídeo tem 2 h e o limite é 15 min."))

    def test_precisa_de_letra_nao_e_falha(self):
        self.handle([NeedsLyrics("Este vídeo não tem legenda.")])
        job = self.r.job()
        self.assertEqual((job["status"], job["error"]), ("needs_lyrics", "Este vídeo não tem legenda."))

    def test_erro_inesperado_nunca_deixa_o_job_travado(self):
        self.handle([KeyError("bug")])
        job = self.r.job()
        self.assertEqual((job["status"], job["error_code"]), ("failed", "unknown"))
        self.assertEqual(self.r.acked, ["1-0"])  # sempre confirmado: não volta para a fila

    def test_job_que_derruba_o_worker_em_loop_e_abandonado(self):
        # simula reinícios: o mesmo pedido começa de novo várias vezes sem terminar (o processo morria no meio)
        self.r.hashes["job:abcdefghijk"] = {"starts": 3}
        proc = self.handle([{}])
        self.assertEqual(proc.call_count, 0)  # nem tenta de novo
        job = self.r.job()
        self.assertEqual((job["status"], job["error_code"]), ("failed", "worker_crash"))
        self.assertEqual(self.r.acked, ["1-0"])

    def test_abaixo_do_limite_de_reinicios_ainda_processa(self):
        self.r.hashes["job:abcdefghijk"] = {"starts": 2}
        proc = self.handle([{}])
        self.assertEqual(proc.call_count, 1)
        self.assertEqual(self.r.job()["status"], "ready")

    def test_durante_a_espera_o_estado_mostra_que_esta_tentando_de_novo(self):
        seen = []
        with mock.patch.object(runner, "process", side_effect=[RuntimeError("timed out"), {}]):
            runner.handle(self.r, None, self.settings, "1-0", dict(self.FIELDS), sleep=lambda s: seen.append(dict(self.r.job())))
        self.assertEqual(seen[0]["stage"], "retrying")
        self.assertIn("tentativa 1 de 3", seen[0]["error"])


class JsonLogTests(unittest.TestCase):
    def logger(self, name):
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        handler.setFormatter(JsonFormatter())
        logger = logging.getLogger(name)
        logger.handlers[:] = [handler]
        logger.propagate = False
        logger.setLevel(logging.INFO)
        return logger, stream

    def test_uma_linha_json_com_os_campos_extras(self):
        logger, stream = self.logger("teste.json")
        logger.info("job pronto", extra={"job": "abc", "elapsed_s": 12.3})
        line = json.loads(stream.getvalue())
        self.assertEqual((line["level"], line["logger"], line["msg"], line["job"], line["elapsed_s"]), ("info", "teste.json", "job pronto", "abc", 12.3))
        self.assertRegex(line["ts"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}\+00:00$")

    def test_acentos_ficam_legiveis_e_excecao_vai_junto(self):
        logger, stream = self.logger("teste.exc")
        try:
            raise ValueError("falhou")
        except ValueError:
            logger.exception("música não achada")
        raw = stream.getvalue()
        self.assertIn("música não achada", raw)  # sem \u00fa
        self.assertIn("ValueError: falhou", json.loads(raw)["exc"])


if __name__ == "__main__":
    unittest.main()
