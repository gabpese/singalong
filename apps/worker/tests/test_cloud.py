"""Uploading the songs to the cloud (hybrid mode): only when the server allows it, meta.json last, nothing unchanged sent again."""
import io
import json
import tempfile
import threading
import unittest
import urllib.error
from pathlib import Path

from singalong_worker import cloud
from singalong_worker.backend import AuthError, BackendUnavailable, HttpBackend, Rejected
from singalong_worker.storage import LocalStorage

SONG = "abcdefghijk"


class Reply(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class Server:
    """A fake server: answers /me and /cloud/missing, and keeps what reaches /cloud/<id>/<file>."""

    def __init__(self, cloud=True, missing=None, fail=None):
        self.cloud, self.missing, self.fail = cloud, missing, fail
        self.puts: list[tuple[str, str, bytes]] = []
        self.checks: list[list[str]] = []

    def __call__(self, request, timeout=None):
        path = request.full_url.split("/agent/v1", 1)[1]
        if request.get_method() == "GET" and path == "/me":
            return Reply(json.dumps({"cloud": self.cloud, "session": None}).encode())
        if path == "/cloud/missing":
            ids = json.loads(request.data)["ids"]
            self.checks.append(ids)
            return Reply(json.dumps({"missing": ids if self.missing is None else [i for i in ids if i in self.missing]}).encode())
        if path.startswith("/cloud/") and request.get_method() == "PUT":
            if self.fail:
                raise self.fail
            _, _, video_id, name = path.split("/")
            assert request.headers["Content-type"] == "application/octet-stream"
            self.puts.append((video_id, name, request.data))
            return Reply(b"")
        raise AssertionError(f"chamada inesperada: {request.get_method()} {path}")


def write(storage, key, data):
    path = storage.root / key
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)


def seed(storage, video_id=SONG, melody=True, backing=False):
    write(storage, f"cache/{video_id}/instrumental.mp3", b"ID3instrumental")
    write(storage, f"cache/{video_id}/lyrics.json", b"[]")
    write(storage, f"cache/{video_id}/meta.json", json.dumps({"video_id": video_id, "title": "T", "artist": "A"}).encode())
    if melody:
        write(storage, f"cache/{video_id}/melody.json", b'{"midi":[60]}')
    if backing:
        write(storage, f"cache/{video_id}/backing.mp3", b"ID3backing")


class CloudTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.storage = LocalStorage(Path(self.tmp.name) / "storage")

    def backend(self, server):
        backend = HttpBackend("https://x.example", "tok", opener=server, retry_wait=0)
        backend.attach_storage(self.storage)
        return backend

    def test_without_authorization_nothing_is_uploaded(self):
        seed(self.storage)
        server = Server(cloud=False)
        backend = self.backend(server)
        self.assertFalse(backend.refresh_cloud())
        self.assertFalse(backend.cloud_enabled)
        self.assertFalse(backend.cloud_sync(SONG))
        self.assertEqual(backend.cloud_backfill(), 0)
        self.assertEqual(server.puts, [])

    def test_authorized_uploads_every_file_with_the_meta_last(self):
        seed(self.storage, backing=True)
        server = Server()
        backend = self.backend(server)
        self.assertTrue(backend.refresh_cloud())
        self.assertTrue(backend.cloud_sync(SONG))
        names = [name for _, name, _ in server.puts]
        self.assertEqual(names, ["instrumental.mp3", "lyrics.json", "melody.json", "backing.mp3", "meta.json"])
        self.assertEqual(server.puts[0][2], b"ID3instrumental")
        self.assertNotIn("vocals.mp3", names)  # the isolated vocals never go up

    def test_optional_files_are_skipped_when_missing(self):
        seed(self.storage, melody=False)
        server = Server()
        backend = self.backend(server)
        backend.refresh_cloud()
        backend.cloud_sync(SONG)
        self.assertEqual([n for _, n, _ in server.puts], ["instrumental.mp3", "lyrics.json", "meta.json"])

    def test_unchanged_files_are_not_sent_again_but_a_new_lyrics_is(self):
        seed(self.storage)
        server = Server()
        backend = self.backend(server)
        backend.refresh_cloud()
        backend.cloud_sync(SONG)
        before = len(server.puts)
        self.assertFalse(backend.cloud_sync(SONG))
        self.assertEqual(len(server.puts), before)
        write(self.storage, f"cache/{SONG}/lyrics.json", b'[{"t":1}]')
        self.assertTrue(backend.cloud_sync(SONG))
        self.assertEqual([n for _, n, _ in server.puts[before:]], ["lyrics.json"])

    def test_a_song_that_is_not_ready_is_not_sent(self):
        write(self.storage, f"cache/{SONG}/instrumental.mp3", b"ID3x")  # the lyrics and the meta are missing
        server = Server()
        backend = self.backend(server)
        backend.refresh_cloud()
        self.assertFalse(backend.cloud_sync(SONG))
        self.assertEqual(server.puts, [])

    def test_backfill_sends_only_what_the_cloud_is_missing(self):
        seed(self.storage, "aaaaaaaaaaa")
        seed(self.storage, "bbbbbbbbbbb")
        server = Server(missing={"bbbbbbbbbbb"})
        backend = self.backend(server)
        backend.refresh_cloud()
        self.assertEqual(backend.cloud_backfill(), 1)
        self.assertEqual({video_id for video_id, _, _ in server.puts}, {"bbbbbbbbbbb"})
        self.assertEqual(server.checks, [["aaaaaaaaaaa", "bbbbbbbbbbb"]])

    def test_publishing_a_song_queues_it_only_when_authorized(self):
        seed(self.storage)
        on = self.backend(Server())
        on.refresh_cloud()
        on.publish_song(SONG)
        self.assertEqual(on.cloud_next(0.1), SONG)
        off = self.backend(Server(cloud=False))
        off.refresh_cloud()
        off.publish_song(SONG)
        self.assertIsNone(off.cloud_next(0.1))

    def test_connect_learns_the_authorization(self):
        server = Server()
        original = server.__call__

        def with_session(request, timeout=None):
            path = request.full_url.split("/agent/v1", 1)[1]
            if request.get_method() == "POST" and path == "/sessions":
                return Reply(json.dumps({"id": "s1"}).encode())
            return original(request, timeout)

        backend = HttpBackend("https://x.example", "tok", opener=with_session, retry_wait=0)
        backend.attach_storage(self.storage)
        backend.connect()
        self.assertTrue(backend.cloud_enabled)

    def test_server_errors_map_to_the_right_exceptions(self):
        seed(self.storage)

        def error(code, body=b"{}"):
            return urllib.error.HTTPError("https://x.example/agent/v1/cloud", code, "x", {}, io.BytesIO(body))

        backend = self.backend(Server(fail=error(401)))
        backend.refresh_cloud()
        with self.assertRaises(AuthError):
            backend.cloud_sync(SONG)
        backend = self.backend(Server(fail=error(403, b'{"error":"cloud_not_allowed","message":"nao"}')))
        backend.refresh_cloud()
        with self.assertRaises(Rejected):
            backend.cloud_sync(SONG)
        backend = self.backend(Server(fail=error(503)))
        backend.refresh_cloud()
        with self.assertRaises(BackendUnavailable):
            backend.cloud_sync(SONG)

    def test_a_song_the_administrator_removed_is_not_pushed_again(self):
        seed(self.storage)
        body = b'{"error":"cloud_blocked","message":"bloqueada"}'
        blocked = urllib.error.HTTPError("https://x.example/agent/v1/cloud", 403, "x", {}, io.BytesIO(body))
        server = Server(fail=blocked)
        backend = self.backend(server)
        backend.refresh_cloud()
        self.assertFalse(backend.cloud_sync(SONG))  # refused: raises no error, just gives up
        server.fail = None
        self.assertFalse(backend.cloud_sync(SONG))  # and does not try again in this run
        self.assertEqual(server.puts, [])

    def test_the_serve_loop_does_the_backfill_then_each_queued_song_and_survives_a_failure(self):
        seed(self.storage, "aaaaaaaaaaa")
        server = Server()
        backend = self.backend(server)
        backend.refresh_cloud()
        stop = threading.Event()
        thread = threading.Thread(target=cloud.serve, args=(backend, self.storage, stop), daemon=True)
        thread.start()
        seed(self.storage, "ccccccccccc")
        backend._shared.cloud_queue.put("ccccccccccc")
        for _ in range(100):
            if {v for v, _, _ in server.puts} >= {"aaaaaaaaaaa", "ccccccccccc"}:
                break
            stop.wait(0.05)
        stop.set()
        thread.join(5)
        self.assertGreaterEqual({v for v, _, _ in server.puts}, {"aaaaaaaaaaa", "ccccccccccc"})


if __name__ == "__main__":
    unittest.main()
