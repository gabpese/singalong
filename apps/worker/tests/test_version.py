"""The app's version: comparison, asking the server, the notice in the heartbeat and the wait when the server requires an update."""
import io
import json
import os
import unittest
import urllib.error
from unittest import mock

from singalong_worker import version
from singalong_worker.backend import BackendUnavailable, HttpBackend, UpdateRequired


class Reply(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


class VersionTests(unittest.TestCase):
    def test_parse_and_compare(self):
        self.assertEqual(version.parse("1.2.3"), (1, 2, 3))
        self.assertEqual(version.parse("v0.10.0-beta.1"), (0, 10, 0))
        for bad in ("", "1.2", "x", None, "1.2.3.4"):
            self.assertIsNone(version.parse(bad))
        self.assertTrue(version.is_older("0.9.0", "0.10.0"))
        self.assertFalse(version.is_older("1.0.0", "1.0.0"))
        self.assertFalse(version.is_older("lixo", "1.0.0"))

    def test_the_app_has_a_valid_version_and_the_env_overrides_it(self):
        self.assertIsNotNone(version.parse(version.__version__))
        with mock.patch.dict(os.environ, {"SINGALONG_AGENT_VERSION": "9.9.9"}):
            self.assertEqual(version.current_version(), "9.9.9")

    def test_check_update_asks_the_open_endpoint(self):
        seen = []

        def fake(request, timeout):
            seen.append(request.full_url)
            return Reply(json.dumps({"status": "update_available", "latest": "2.0.0"}).encode())

        with mock.patch("urllib.request.urlopen", fake):
            info = version.check_update("https://x.example/", "1.0.0")
        self.assertEqual(info["status"], "update_available")
        self.assertEqual(seen, ["https://x.example/agent/v1/version?current=1.0.0"])

    def test_check_update_returns_none_when_offline(self):
        with mock.patch("urllib.request.urlopen", side_effect=urllib.error.URLError("sem rede")):
            self.assertIsNone(version.check_update("https://x.example", "1.0.0"))


class HeartbeatTests(unittest.TestCase):
    def backend(self, replies):
        calls = []

        def opener(request, timeout):
            calls.append(request.full_url)
            reply = replies.pop(0)
            if isinstance(reply, Exception):
                raise reply
            return Reply(json.dumps(reply).encode())

        return HttpBackend("https://x.example", "tok", opener=opener, retry_wait=0), calls

    def test_heartbeat_keeps_the_update_notice_shared_with_clones(self):
        backend, _ = self.backend([{"ok": True, "session_id": "s1", "update": {"status": "update_available", "latest": "9.0.0", "notes": "Corrige o login"}}])
        backend.heartbeat()
        self.assertEqual(backend.update["status"], "update_available")
        self.assertEqual(backend.clone().update["latest"], "9.0.0")

    def test_logs_only_when_the_status_changes(self):
        info = {"status": "update_available", "latest": "9.0.0"}
        backend, _ = self.backend([{"session_id": "s", "update": info}, {"session_id": "s", "update": info}])
        with self.assertLogs("worker.backend", level="WARNING") as logs:
            backend.heartbeat()
            backend.heartbeat()
        self.assertEqual(len(logs.records), 1)

    def test_426_waits_like_a_temporary_failure_instead_of_crashing(self):
        body = io.BytesIO(json.dumps({"error": "update_required", "message": "Atualize"}).encode())
        error = urllib.error.HTTPError("https://x.example/agent/v1/jobs/claim", 426, "Upgrade Required", {}, body)
        backend, _ = self.backend([error])
        with self.assertRaises(UpdateRequired) as ctx:
            backend.next_job(0)
        self.assertIsInstance(ctx.exception, BackendUnavailable)  # the agent's loop already waits and tries again
        self.assertIn("Atualize", str(ctx.exception))


class CliTests(unittest.TestCase):
    def run_cli(self, argv, info=None):
        from singalong_worker import cli

        out = io.StringIO()
        with mock.patch("singalong_worker.version.check_update", return_value=info), mock.patch("sys.stdout", out):
            code = cli.main(argv)
        return code, out.getvalue()

    def test_version_flag(self):
        code, out = self.run_cli(["--version"])
        self.assertEqual((code, out.strip()), (0, version.current_version()))

    def test_check_update_messages_and_exit_codes(self):
        base = ["--check-update", "--agent-url", "https://x.example"]
        code, out = self.run_cli(base, {"status": "update_available", "latest": "9.0.0", "notes": "Corrige o login", "url": "https://baixar"})
        self.assertEqual(code, 0)
        self.assertIn("9.0.0", out)
        self.assertIn("Corrige o login", out)
        code, out = self.run_cli(base, {"status": "update_required", "minimum": "5.0.0"})
        self.assertEqual(code, 1)
        self.assertEqual(self.run_cli(base, None)[0], 4)
        self.assertEqual(self.run_cli(["--check-update"])[0], 2)


if __name__ == "__main__":
    unittest.main()
