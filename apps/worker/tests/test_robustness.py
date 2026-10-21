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
from singalong_worker.backend import Job
from singalong_worker.errors import AUTO, MANUAL, NEVER, JobError, classify, format_duration
from singalong_worker.logsetup import JsonFormatter
from singalong_worker.pipeline import Limits, NeedsLyrics, check_disk, validate_video_info


class ClassifyTests(unittest.TestCase):
    def check(self, text, code, retry):
        err = classify(RuntimeError(text))
        self.assertEqual((err.code, err.retry), (code, retry), text)
        self.assertTrue(err.message.strip())
        return err

    def test_real_youtube_messages(self):
        self.check("ERROR: [youtube] abc: Private video. Sign in if you've been granted access to this video", "private", NEVER)
        self.check("ERROR: [youtube] abc: Video unavailable", "unavailable", NEVER)
        self.check("ERROR: [youtube] abc: This video has been removed by the uploader", "unavailable", NEVER)
        self.check("ERROR: [youtube] abc: Video unavailable. This video contains content from SME, who has blocked it on copyright grounds", "copyright", NEVER)
        self.check("ERROR: [youtube] abc: The uploader has not made this video available in your country", "geo", NEVER)
        self.check("ERROR: [youtube] abc: Sign in to confirm your age. This video may be inappropriate for some users.", "age", NEVER)
        self.check("ERROR: [youtube] abc: This live event will begin in 2 days.", "live", NEVER)
        self.check("ERROR: [youtube] abc: Join this channel to get access to members-only content", "members", NEVER)

    def test_expired_cookies_ask_for_manual_action(self):
        err = self.check("ERROR: [youtube] abc: Sign in to confirm you’re not a bot. Use --cookies-from-browser or --cookies", "cookies", MANUAL)
        self.assertIn("youtube_cookies.txt", err.message)

    def test_transient_failures_are_retried_automatically(self):
        self.check("ERROR: Unable to download video subtitles for 'en': HTTP Error 429: Too Many Requests", "rate_limited", AUTO)
        self.check("urlopen error [Errno -3] Temporary failure in name resolution", "network", AUTO)
        self.check("HTTP Error 503: Service Unavailable", "network", AUTO)
        self.check("The read operation timed out", "network", AUTO)

    def test_machine_failures(self):
        self.check("CUDA out of memory. Tried to allocate 1.2 GiB", "gpu_memory", MANUAL)
        self.check("[Errno 28] No space left on device", "disk_full", MANUAL)
        self.assertEqual(classify(OSError(errno.ENOSPC, "x")).code, "disk_full")
        self.assertEqual(classify(subprocess.TimeoutExpired("demucs", 5)).code, "timeout")
        self.assertEqual(classify(subprocess.CalledProcessError(1, "ffmpeg")).code, "audio")
        self.check("ERROR: Requested format is not available. Use --list-formats", "format", MANUAL)

    def test_an_unknown_error_never_becomes_an_empty_message(self):
        err = classify(KeyError("algo"))
        self.assertEqual((err.code, err.retry), ("unknown", MANUAL))
        self.assertIn("KeyError", err.message)

    def test_job_error_passes_straight_through(self):
        original = JobError("too_long", "longo demais", NEVER)
        self.assertIs(classify(original), original)

    def test_priority_cookies_before_private(self):
        # "Sign in" appears in several errors; the bot/cookies one must win over the generic one
        self.assertEqual(classify(RuntimeError("Sign in to confirm you're not a bot")).code, "cookies")

    def test_format_duration(self):
        self.assertEqual(format_duration(45), "45 s")
        self.assertEqual(format_duration(200), "3 min 20 s")
        self.assertEqual(format_duration(3900), "1 h 05 min")


class ValidateVideoTests(unittest.TestCase):
    def test_refuses_live_private_members_only_and_too_long(self):
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

    def test_the_limit_message_states_both_durations(self):
        with self.assertRaises(JobError) as ctx:
            validate_video_info({"duration": 7800}, 900)
        self.assertIn("2 h 10 min", ctx.exception.message)
        self.assertIn("15 min", ctx.exception.message)

    def test_accepts_the_normal_case_and_the_exact_or_disabled_limit(self):
        validate_video_info({"duration": 222, "availability": "public", "is_live": False}, 900)
        validate_video_info({"duration": 900}, 900)  # exactly at the limit: passes
        validate_video_info({"duration": 99999}, None)  # limit off
        validate_video_info({}, 900)  # no known duration: it cannot refuse

    def test_limits_from_the_environment(self):
        with mock.patch.dict("os.environ", {"MAX_DURATION_SECONDS": "0", "MIN_FREE_GB": "5", "SEPARATE_TIMEOUT_SECONDS": "60"}):
            limits = Limits.from_env()
        self.assertEqual((limits.max_duration, limits.min_free_gb, limits.separate_timeout), (None, 5.0, 60.0))
        with mock.patch.dict("os.environ", {"MAX_DURATION_SECONDS": "lixo"}):
            self.assertEqual(Limits.from_env().max_duration, 900)  # an invalid value falls back to the default


class DiskGuardTests(unittest.TestCase):
    def test_without_space_refuses_with_a_message(self):
        usage = shutil._ntuple_diskusage(100 * 1024**3, 99 * 1024**3, int(0.5 * 1024**3))
        with tempfile.TemporaryDirectory() as d:
            check_disk(d, 0)  # off
            check_disk(d, 0.000001)  # space to spare
            with mock.patch.object(shutil, "disk_usage", return_value=usage):
                with self.assertRaises(JobError) as ctx:
                    check_disk(d, 2)
        self.assertEqual((ctx.exception.code, ctx.exception.retry), ("disk_full", MANUAL))
        self.assertIn("0.5 GB", ctx.exception.message)


class CheckDiskNewFolderTests(unittest.TestCase):
    def test_a_library_folder_that_does_not_exist_yet_does_not_break_the_first_run(self):
        with tempfile.TemporaryDirectory() as d:
            check_disk(Path(d) / "storage" / "ainda" / "nao" / "existe", 0)  # raises no FileNotFoundError
            with mock.patch("shutil.disk_usage", return_value=mock.Mock(free=int(0.5 * 1024**3))):
                with self.assertRaises(JobError) as ctx:
                    check_disk(Path(d) / "nova", 2)  # and still measures the real space
        self.assertEqual(ctx.exception.code, "disk_full")


class FakeBackend:
    """Only what the runner uses from the Backend: the job's state, the start counter, the ack and the backing vocals request."""

    def __init__(self):
        self.states, self.acked, self.backing, self.events = {}, [], [], []

    def begin(self, job):
        state = self.states.setdefault(job.video_id, {})
        state["starts"] = int(state.get("starts", 0)) + 1
        return state["starts"]

    def set_state(self, job, **fields):
        self.states.setdefault(job.video_id, {}).update(fields)
        self.events.append(("state", fields.get("status")))

    def publish_song(self, video_id):
        self.events.append(("publish", video_id))

    def finish(self, job):
        self.acked.append(job.ref)

    def request_backing(self, video_id):
        self.backing.append(video_id)

    def job(self, vid="abcdefghijk"):
        return self.states[vid]


class RunnerTests(unittest.TestCase):
    PAYLOAD = {"url": "https://youtu.be/abcdefghijk", "lyrics_source": "auto"}

    def setUp(self):
        self.r = FakeBackend()
        self.settings = runner.Settings("redis://x", "/tmp", None, None, ["pt"], 1800, Path("/tmp/hb"), retry_wait=5)
        self.sleeps = []

    def new_job(self):
        return Job("abcdefghijk", dict(self.PAYLOAD), ref="1-0")

    def handle(self, side_effect):
        with mock.patch.object(runner, "process", side_effect=side_effect) as proc:
            runner.handle(self.r, None, self.settings, self.new_job(), sleep=self.sleeps.append)
        return proc

    def test_success(self):
        proc = self.handle([{}])
        self.assertEqual(proc.call_count, 1)
        self.assertEqual(self.r.job()["status"], "ready")
        self.assertEqual(self.r.acked, ["1-0"])
        self.assertEqual(self.r.job()["error_code"], "")

    def test_the_song_is_published_to_the_catalog_before_the_job_ends(self):
        # local storage: the cloud only sees the finished song after it is in the catalog
        self.handle([{}])
        events = self.r.events
        self.assertLess(events.index(("publish", "abcdefghijk")), events.index(("state", "ready")))
        self.handle([RuntimeError("ERROR: [youtube] x: Private video. Sign in if you've been granted access")])
        self.assertEqual(self.r.events.count(("publish", "abcdefghijk")), 1)  # a failed job publishes nothing

    def test_a_transient_failure_retries_with_a_growing_wait_and_ends_ready(self):
        proc = self.handle([RuntimeError("HTTP Error 429"), RuntimeError("timed out"), {}])
        self.assertEqual(proc.call_count, 3)
        self.assertEqual(self.sleeps, [5, 20])  # 5 s, then 4x
        self.assertEqual(self.r.job()["status"], "ready")

    def test_a_transient_failure_that_persists_fails_after_the_attempts_with_a_clear_message(self):
        proc = self.handle([RuntimeError("HTTP Error 429")] * 5)
        self.assertEqual(proc.call_count, 3)  # WORKER_MAX_ATTEMPTS
        job = self.r.job()
        self.assertEqual((job["status"], job["error_code"], job["retry"]), ("failed", "rate_limited", "auto"))
        self.assertIn("limitou os pedidos", job["error"])
        self.assertEqual(self.r.acked, ["1-0"])

    def test_an_unfixable_error_is_not_retried(self):
        proc = self.handle([RuntimeError("ERROR: [youtube] x: Private video. Sign in if you've been granted access")])
        self.assertEqual(proc.call_count, 1)
        self.assertEqual(self.sleeps, [])
        job = self.r.job()
        self.assertEqual((job["status"], job["error_code"], job["retry"]), ("failed", "private", "never"))
        self.assertEqual(job["error"], "Este vídeo é privado. Escolha outro vídeo.")

    def test_a_job_error_from_the_pipeline_becomes_its_message(self):
        self.handle([JobError("too_long", "O vídeo tem 2 h e o limite é 15 min.", NEVER)])
        job = self.r.job()
        self.assertEqual((job["error_code"], job["error"]), ("too_long", "O vídeo tem 2 h e o limite é 15 min."))

    def test_needs_lyrics_is_not_a_failure(self):
        self.handle([NeedsLyrics("Este vídeo não tem legenda.")])
        job = self.r.job()
        self.assertEqual((job["status"], job["error"]), ("needs_lyrics", "Este vídeo não tem legenda."))

    def test_an_unexpected_error_never_leaves_the_job_stuck(self):
        self.handle([KeyError("bug")])
        job = self.r.job()
        self.assertEqual((job["status"], job["error_code"]), ("failed", "unknown"))
        self.assertEqual(self.r.acked, ["1-0"])  # always acknowledged: it does not go back to the queue

    def test_a_job_that_crashes_the_worker_in_a_loop_is_abandoned(self):
        # simulates restarts: the same request starts again several times without finishing (the process died midway)
        self.r.states["abcdefghijk"] = {"starts": 3}
        proc = self.handle([{}])
        self.assertEqual(proc.call_count, 0)  # does not even try again
        job = self.r.job()
        self.assertEqual((job["status"], job["error_code"]), ("failed", "worker_crash"))
        self.assertEqual(self.r.acked, ["1-0"])

    def test_below_the_restart_limit_it_still_processes(self):
        self.r.states["abcdefghijk"] = {"starts": 2}
        proc = self.handle([{}])
        self.assertEqual(proc.call_count, 1)
        self.assertEqual(self.r.job()["status"], "ready")
        self.assertEqual(self.r.backing, ["abcdefghijk"])  # ready: the backing vocals come later, in the background

    def test_during_the_wait_the_state_shows_it_is_retrying(self):
        seen = []
        with mock.patch.object(runner, "process", side_effect=[RuntimeError("timed out"), {}]):
            runner.handle(self.r, None, self.settings, self.new_job(), sleep=lambda s: seen.append(dict(self.r.job())))
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

    def test_one_json_line_with_the_extra_fields(self):
        logger, stream = self.logger("teste.json")
        logger.info("job pronto", extra={"job": "abc", "elapsed_s": 12.3})
        line = json.loads(stream.getvalue())
        self.assertEqual((line["level"], line["logger"], line["msg"], line["job"], line["elapsed_s"]), ("info", "teste.json", "job pronto", "abc", 12.3))
        self.assertRegex(line["ts"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}\+00:00$")

    def test_accents_stay_readable_and_the_exception_goes_along(self):
        logger, stream = self.logger("teste.exc")
        try:
            raise ValueError("falhou")
        except ValueError:
            logger.exception("música não achada")
        raw = stream.getvalue()
        self.assertIn("música não achada", raw)  # no \u00fa
        self.assertIn("ValueError: falhou", json.loads(raw)["exc"])


if __name__ == "__main__":
    unittest.main()
