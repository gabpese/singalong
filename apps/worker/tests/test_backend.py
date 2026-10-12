"""Os dois transportes do worker: Redis (clássico) e HTTP (agente local). Sem rede e sem Redis: tudo com dublês."""
import io
import json
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

from singalong_worker import backend as backend_module
from singalong_worker.storage import LocalStorage
from singalong_worker.backend import (
    BACKING_KEY, DONE_TTL, EXPORT_KEY, FAILED_TTL, GROUP, SEARCH_KEY, STREAM, AuthError, BackendUnavailable, HttpBackend, Job, Rejected,
    RedisBackend, make_backend, pair,
)


# ---------------------------------------------------------------------------------------------------------------------
# Redis
# ---------------------------------------------------------------------------------------------------------------------
class FakeRedisClient:
    """Só o que o RedisBackend usa, guardando as chamadas."""

    def __init__(self):
        self.calls, self.hashes, self.expires, self.acked = [], {}, {}, []
        self.pending_entries, self.new_entries, self.claimed, self.lists = [], [], [], {}
        self.raise_on = None

    def _maybe_raise(self):
        if isinstance(self.raise_on, BaseException):
            raise self.raise_on

    def ping(self):
        self._maybe_raise()

    def xgroup_create(self, stream, group, id="0", mkstream=False):
        self.calls.append(("xgroup_create", stream, group, id, mkstream))
        if self.raise_on == "busy":
            raise RuntimeError("BUSYGROUP Consumer Group name already exists")

    def xreadgroup(self, group, consumer, streams, count=None, block=None):
        self._maybe_raise()
        self.calls.append(("xreadgroup", group, consumer, streams, count, block))
        entries = self.pending_entries if list(streams.values())[0] == "0" else self.new_entries
        return [[STREAM, list(entries)]] if entries else []

    def xautoclaim(self, stream, group, consumer, min_idle_time, start_id, count):
        self.calls.append(("xautoclaim", stream, group, consumer, min_idle_time, start_id, count))
        return ["0-0", list(self.claimed), []]

    def hincrby(self, key, field, amount):
        h = self.hashes.setdefault(key, {})
        h[field] = int(h.get(field, 0)) + amount
        return h[field]

    def hset(self, key, mapping):
        self.hashes.setdefault(key, {}).update(mapping)

    def expire(self, key, ttl):
        self.expires[key] = ttl

    def xack(self, stream, group, msg_id):
        self.acked.append((stream, group, msg_id))

    def lpush(self, key, value):
        self.lists.setdefault(key, []).insert(0, value)

    def brpop(self, key, timeout):
        self.calls.append(("brpop", key, timeout))
        items = self.lists.get(key, [])
        return (key, items.pop()) if items else None


def entry(msg_id, vid="abcdefghijk", **payload):
    return (msg_id, {"video_id": vid, "payload": json.dumps({"url": f"https://www.youtube.com/watch?v={vid}", "lyrics_source": "auto", **payload})})


class RedisBackendTests(unittest.TestCase):
    def setUp(self):
        self.client = FakeRedisClient()
        self.b = RedisBackend("redis://x", "worker-1", client=self.client)

    def test_connect_cria_o_grupo_e_aceita_que_ele_ja_exista(self):
        self.b.connect()
        self.assertIn(("xgroup_create", STREAM, GROUP, "0", True), self.client.calls)
        self.client.raise_on = "busy"
        self.b.connect()  # BUSYGROUP é o caso normal

    def test_pending_e_next_job_viram_job_com_o_id_da_mensagem(self):
        self.client.pending_entries = [entry("1-0")]
        self.client.new_entries = [entry("2-0", "lmnopqrstuv", artist="X")]
        (first,) = self.b.pending()
        self.assertEqual((first.video_id, first.ref, first.payload["lyrics_source"]), ("abcdefghijk", "1-0", "auto"))
        job = self.b.next_job(5)
        self.assertEqual((job.video_id, job.ref, job.payload["artist"]), ("lmnopqrstuv", "2-0", "X"))
        self.assertIn(("xreadgroup", GROUP, "worker-1", {STREAM: ">"}, 1, 5000), self.client.calls)

    def test_sem_nada_novo_next_job_devolve_none(self):
        self.assertIsNone(self.b.next_job(5))

    def test_reclaim_pede_os_jobs_parados_ha_mais_de_n_segundos(self):
        self.client.claimed = [entry("3-0")]
        (job,) = self.b.reclaim(1800)
        self.assertEqual(job.ref, "3-0")
        self.assertIn(("xautoclaim", STREAM, GROUP, "worker-1", 1_800_000, "0-0", 10), self.client.calls)

    def test_begin_conta_os_inicios(self):
        job = Job("abcdefghijk", {}, ref="1-0")
        self.assertEqual([self.b.begin(job), self.b.begin(job)], [1, 2])

    def test_set_state_grava_o_estado_e_expira_so_os_finais(self):
        job = Job("abcdefghijk", {}, ref="1-0")
        self.b.set_state(job, status="processing", stage="separando", error=None)
        state = self.client.hashes["job:abcdefghijk"]
        self.assertEqual((state["status"], state["stage"], state["error"]), ("processing", "separando", ""))
        self.assertIn("updated_at", state)
        self.assertNotIn("job:abcdefghijk", self.client.expires)
        self.b.set_state(job, status="ready")
        self.assertEqual(self.client.expires["job:abcdefghijk"], DONE_TTL)
        self.b.set_state(job, status="failed", error_code="private")
        self.assertEqual(self.client.expires["job:abcdefghijk"], FAILED_TTL)
        self.b.set_state(job, status="needs_lyrics")
        self.assertEqual(self.client.expires["job:abcdefghijk"], FAILED_TTL)

    def test_finish_da_ack_na_mensagem(self):
        self.b.finish(Job("abcdefghijk", {}, ref="1-0"))
        self.assertEqual(self.client.acked, [(STREAM, GROUP, "1-0")])

    def test_fila_das_vozes_de_apoio_e_as_de_busca_e_exportacao(self):
        self.b.request_backing("abcdefghijk")
        self.assertEqual(self.b.next_backing(2), "abcdefghijk")
        self.assertIsNone(self.b.next_backing(2))
        self.client.lists[SEARCH_KEY] = [json.dumps({"id": "r1", "q": "legiao urbana"})]
        self.assertEqual(self.b.next_search(2), {"id": "r1", "q": "legiao urbana"})
        self.b.reply_search("r1", {"results": [{"video_id": "abcdefghijk", "title": "T"}]})
        self.assertEqual(json.loads(self.client.lists["search:res:r1"][0])["results"][0]["title"], "T")
        self.assertEqual(self.client.expires["search:res:r1"], 60)
        self.client.lists[EXPORT_KEY] = [json.dumps({"video_id": "abcdefghijk", "pitch": 2})]
        self.assertEqual(self.b.next_export(2), {"video_id": "abcdefghijk", "pitch": 2})
        self.b.set_export_state("abcdefghijk", 2, "failed", "ffmpeg falhou")
        self.assertEqual(self.client.hashes["export:abcdefghijk:2"]["error"], "ffmpeg falhou")
        self.assertEqual(self.client.expires["export:abcdefghijk:2"], 3600)
        self.assertEqual(BACKING_KEY, "backing:req")

    def test_falha_de_conexao_vira_backend_unavailable(self):
        self.client.raise_on = ConnectionError("recusada")
        with self.assertRaises(BackendUnavailable):
            self.b.next_job(1)
        with self.assertRaises(BackendUnavailable):
            self.b.connect()

    def test_clone_usa_outra_conexao(self):
        other = self.b.clone()
        self.assertIsNot(other, self.b)
        self.assertEqual((other.url, other.consumer), ("redis://x", "worker-1"))


# ---------------------------------------------------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------------------------------------------------
class FakeResponse:
    def __init__(self, body=b""):
        self._body = body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self):
        return self._body


class FakeServer:
    """Um `urlopen` falso: guarda as requisições e responde na ordem (ou pelo caminho)."""

    def __init__(self):
        self.requests, self.queue, self.by_path = [], [], {}

    def reply(self, body=None, status=200, path=None):
        item = (status, body)
        (self.by_path.setdefault(path, []) if path else self.queue).append(item)

    def __call__(self, request, timeout=None):
        path = request.full_url.split("/agent/v1", 1)[1]
        sent = json.loads(request.data) if request.data else None
        self.requests.append({"method": request.get_method(), "path": path, "body": sent, "auth": request.get_header("Authorization"), "timeout": timeout})
        status, body = self.by_path[path].pop(0) if self.by_path.get(path) else (self.queue.pop(0) if self.queue else (204, None))
        if isinstance(body, Exception):
            raise body
        if status >= 400:
            raise urllib.error.HTTPError(request.full_url, status, "erro", {}, io.BytesIO(json.dumps(body or {}).encode()))
        return FakeResponse(b"" if body is None else json.dumps(body).encode())


class HttpBackendTests(unittest.TestCase):
    def setUp(self):
        self.server = FakeServer()
        self.b = HttpBackend("https://sing.example.org/", "sga_token", "Gabriel", opener=self.server, retry_wait=0)
        self.b._shared.session_id = "sess-1"
        self.job = Job("abcdefghijk", {}, attempt=2)

    def sent(self, path):
        return [r for r in self.server.requests if r["path"] == path]

    def test_next_job_manda_o_token_e_a_espera_e_devolve_o_job_com_a_tentativa(self):
        self.server.reply({"job": {"id": "abcdefghijk", "payload": {"url": "u", "lyrics_source": "lrclib"}, "attempt": 2}})
        job = self.b.next_job(5)
        self.assertEqual((job.video_id, job.payload["lyrics_source"], job.attempt), ("abcdefghijk", "lrclib", 2))
        (req,) = self.sent("/jobs/claim")
        self.assertEqual((req["method"], req["auth"], req["body"]), ("POST", "Bearer sga_token", {"wait_ms": 5000}))
        self.assertGreater(req["timeout"], 5)  # a espera do servidor cabe no tempo limite da conexão

    def test_sem_trabalho_o_servidor_responde_204_e_next_job_devolve_none(self):
        self.assertIsNone(self.b.next_job(5))
        self.assertIsNone(self.b.next_job(0.5))
        self.assertEqual(self.sent("/jobs/claim")[1]["body"], {"wait_ms": 500})

    def test_begin_usa_a_contagem_do_servidor(self):
        self.assertEqual(self.b.begin(self.job), 2)
        self.assertEqual(self.b.begin(Job("x" * 11, {})), 1)

    def test_set_state_andamento_vai_para_progress_sem_o_status(self):
        self.b.set_state(self.job, status="processing", stage="separando", error="", error_code=None, retry="")
        (req,) = self.sent("/jobs/abcdefghijk/progress")
        self.assertEqual(req["body"], {"stage": "separando", "error": "", "error_code": "", "retry": ""})
        self.assertEqual(self.sent("/jobs/abcdefghijk/complete"), [])

    def test_set_state_final_vai_para_complete_com_o_status(self):
        self.b.set_state(self.job, status="failed", stage="", error="Este vídeo é privado.", error_code="private", retry="never")
        (req,) = self.sent("/jobs/abcdefghijk/complete")
        self.assertEqual(req["body"], {"status": "failed", "stage": "", "error": "Este vídeo é privado.", "error_code": "private", "retry": "never"})
        self.b.set_state(self.job, status="needs_lyrics", error="sem legenda")
        self.assertEqual(self.sent("/jobs/abcdefghijk/complete")[1]["body"]["status"], "needs_lyrics")

    def test_textos_longos_sao_cortados_no_limite_do_servidor(self):
        self.b.set_state(self.job, status="processing", error="x" * 900)
        self.assertEqual(len(self.sent("/jobs/abcdefghijk/progress")[0]["body"]["error"]), 500)

    def test_o_final_do_job_e_repetido_em_falha_de_conexao_mas_o_andamento_nao_derruba_nada(self):
        self.server.reply(urllib.error.URLError("sem rede"), path="/jobs/abcdefghijk/complete")
        self.server.reply(urllib.error.URLError("sem rede"), path="/jobs/abcdefghijk/complete")
        self.b.set_state(self.job, status="ready")
        self.assertEqual(len(self.sent("/jobs/abcdefghijk/complete")), 3)  # duas falhas + a que passou
        self.server.reply(urllib.error.URLError("sem rede"), path="/jobs/abcdefghijk/progress")
        self.b.set_state(self.job, status="processing", stage="x")  # só registra no log

    def test_servidor_recusando_o_estado_nao_derruba_o_worker(self):
        self.server.reply({"error": "not_your_job"}, status=409, path="/jobs/abcdefghijk/complete")
        self.b.set_state(self.job, status="ready")  # outro agente ficou com o job: só registra

    def test_erros_http(self):
        self.server.reply({"message": "token inválido"}, status=401)
        with self.assertRaises(AuthError):
            self.b.next_job(1)
        for status in (500, 503, 429):
            self.server.reply({}, status=status)
            with self.assertRaises(BackendUnavailable, msg=str(status)):
                self.b.next_job(1)
        self.server.reply(urllib.error.URLError("recusada"))
        with self.assertRaises(BackendUnavailable):
            self.b.next_job(1)
        self.server.reply(TimeoutError("lento"))
        with self.assertRaises(BackendUnavailable):
            self.b.next_job(1)
        self.server.reply({"error": "forbidden", "message": "não pode"}, status=403)
        with self.assertRaises(Rejected) as ctx:
            self.b.next_job(1)
        self.assertEqual((ctx.exception.status, ctx.exception.code), (403, "forbidden"))

    def test_connect_retoma_a_sessao_ativa_ou_inicia_uma(self):
        self.server.reply({"device": {"id": "d"}, "session": {"id": "velha", "display_name": "x"}}, path="/me")
        self.server.reply({"id": "velha", "display_name": "Gabriel"}, path="/sessions")
        self.b.connect()
        self.assertEqual(self.b.session_id, "velha")
        self.assertEqual(self.sent("/sessions")[0]["body"], {"display_name": "Gabriel", "resume_id": "velha"})
        self.server.reply({"device": {"id": "d"}, "session": None}, path="/me")
        self.server.reply({"id": "nova", "display_name": "Gabriel"}, path="/sessions")
        self.b.connect()
        self.assertEqual(self.b.session_id, "nova")
        self.assertEqual(self.sent("/sessions")[1]["body"], {"display_name": "Gabriel"})

    def test_connect_com_keep_name_nao_renomeia_a_sessao_retomada(self):
        # outro comando (--create-room) retoma a sessão do agente em execução sem trocar o apelido que o dono escolheu
        self.server.reply({"device": {"id": "d"}, "session": {"id": "viva", "display_name": "Gabriel"}}, path="/me")
        self.server.reply({"id": "viva", "display_name": "Gabriel"}, path="/sessions")
        other = HttpBackend("https://sing.example.org", "sga_token", "Meu computador", opener=self.server)
        other.connect(keep_name=True)
        self.assertEqual(self.sent("/sessions")[0]["body"], {"display_name": "Gabriel", "resume_id": "viva"})
        # sem sessão ativa, usa o nome pedido (mesmo com keep_name)
        self.server.reply({"device": {"id": "d"}, "session": None}, path="/me")
        self.server.reply({"id": "nova", "display_name": "Meu computador"}, path="/sessions")
        other.connect(keep_name=True)
        self.assertEqual(self.sent("/sessions")[1]["body"], {"display_name": "Meu computador"})

    def test_sem_sessao_ativa_o_claim_inicia_outra_e_tenta_depois(self):
        self.server.reply({"error": "no_active_session"}, status=409, path="/jobs/claim")
        self.server.reply({"device": {"id": "d"}, "session": None}, path="/me")
        self.server.reply({"id": "nova", "display_name": "Gabriel"}, path="/sessions")
        self.assertIsNone(self.b.next_job(1))
        self.assertEqual(self.b.session_id, "nova")

    def test_heartbeat_reconecta_se_o_servidor_encerrou_a_sessao(self):
        self.server.reply({"ok": True, "session_id": "sess-1"}, path="/heartbeat")
        self.b.heartbeat()
        self.assertEqual(self.sent("/me"), [])
        self.server.reply({"ok": True, "session_id": None}, path="/heartbeat")
        self.server.reply({"device": {"id": "d"}, "session": None}, path="/me")
        self.server.reply({"id": "outra", "display_name": "Gabriel"}, path="/sessions")
        self.b.heartbeat()
        self.assertEqual(self.b.session_id, "outra")

    def test_busca(self):
        self.server.reply({"request": {"id": "r1", "q": "legiao"}}, path="/search/claim")
        self.assertEqual(self.b.next_search(2), {"id": "r1", "q": "legiao"})
        self.assertIsNone(self.b.next_search(2))
        self.b.reply_search("r1", {"results": [{"video_id": "abcdefghijk", "title": "T"}]})
        self.assertEqual(self.sent("/search/r1/result")[0]["body"], {"results": [{"video_id": "abcdefghijk", "title": "T"}]})
        self.b.reply_search("r2", {"error": "YouTube bloqueou"})
        self.assertEqual(self.sent("/search/r2/result")[0]["body"], {"error": "YouTube bloqueou"})
        self.server.reply({"error": "unknown_search"}, status=409, path="/search/r3/result")
        self.b.reply_search("r3", {"results": []})  # já venceu: não derruba a thread

    def test_exportacao(self):
        self.server.reply({"request": {"video_id": "abcdefghijk", "pitch": -2}}, path="/exports/claim")
        self.assertEqual(self.b.next_export(2), {"video_id": "abcdefghijk", "pitch": -2})
        self.b.set_export_state("abcdefghijk", -2, "processing")
        self.b.set_export_state("abcdefghijk", -2, "failed", "ffmpeg falhou")
        sent = self.sent("/exports/abcdefghijk/-2/state")
        self.assertEqual([s["body"] for s in sent], [{"status": "processing"}, {"status": "failed", "error": "ffmpeg falhou"}])

    def test_vozes_de_apoio_usam_uma_fila_interna_compartilhada_entre_as_copias(self):
        other = self.b.clone()
        self.b.request_backing("abcdefghijk")
        self.assertEqual(other.next_backing(0.1), "abcdefghijk")
        self.assertIsNone(other.next_backing(0.1))
        self.assertEqual(self.server.requests, [])  # nada disso passa pelo servidor
        self.assertEqual(other.session_id, "sess-1")  # a sessão também é compartilhada

    def test_pending_e_reclaim_ficam_com_o_servidor(self):
        self.assertEqual((self.b.pending(), self.b.reclaim(1800)), ([], []))

    def test_create_room_usa_a_sessao_ativa(self):
        self.server.reply({"code": "ABCD", "host_token": "tok", "session_id": "sess-1"}, path="/sessions/sess-1/rooms")
        self.assertEqual(self.b.create_room()["code"], "ABCD")

    def test_end_session(self):
        self.b.end_session()
        self.assertEqual(self.sent("/sessions/sess-1")[0]["method"], "DELETE")
        self.assertIsNone(self.b.session_id)


class FactoryAndPairTests(unittest.TestCase):
    def test_make_backend_escolhe_pelo_ambiente(self):
        self.assertIsInstance(make_backend("redis://x", "w", None, None, "n"), RedisBackend)
        http = make_backend("redis://x", "w", "https://s.example.org", "sga_t", "Gabriel")
        self.assertIsInstance(http, HttpBackend)
        self.assertEqual(http.session_name, "Gabriel")
        with self.assertRaises(ValueError):
            make_backend("redis://x", "w", "https://s.example.org", None, "n")

    def test_pair(self):
        seen = {}

        def opener(request, timeout=None):
            seen.update(url=request.full_url, body=json.loads(request.data), auth=request.get_header("Authorization"))
            return FakeResponse(json.dumps({"device_id": "d1", "token": "sga_abc"}).encode())

        result = pair("https://s.example.org/", "ABCD2345", "Notebook", opener=opener)
        self.assertEqual(result["token"], "sga_abc")
        self.assertEqual(seen["url"], "https://s.example.org/agent/v1/pair/complete")
        self.assertEqual(seen["body"], {"code": "ABCD2345", "name": "Notebook"})
        self.assertIsNone(seen["auth"])  # o código é o segredo: nenhum token ainda

    def test_pair_com_codigo_invalido_e_servidor_fora(self):
        def rejecting(request, timeout=None):
            raise urllib.error.HTTPError(request.full_url, 400, "x", {}, io.BytesIO(json.dumps({"error": "invalid_pair_code", "message": "vencido"}).encode()))

        with self.assertRaises(Rejected) as ctx:
            pair("https://s.example.org", "X", opener=rejecting)
        self.assertEqual(ctx.exception.code, "invalid_pair_code")

        def down(request, timeout=None):
            raise urllib.error.URLError("sem rede")

        with self.assertRaises(BackendUnavailable):
            pair("https://s.example.org", "X", opener=down)


class HttpCatalogTests(unittest.TestCase):
    """Armazenamento local: o agente publica o catálogo e diz à nuvem onde o navegador busca a mídia."""

    BASE = "http://127.0.0.1:8765/tok123"

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.server = FakeServer()
        self.b = HttpBackend("https://sing.example.org", "sga_token", "Gabriel", opener=self.server, retry_wait=0)
        self.b._shared.session_id = "sess-1"
        self.b.attach_storage(LocalStorage(self.root))

    def song(self, vid="abcdefghijk", ready=True):
        folder = self.root / "cache" / vid
        folder.mkdir(parents=True, exist_ok=True)
        (folder / "instrumental.mp3").write_bytes(b"x")
        if ready:
            (folder / "lyrics.json").write_text("[]", encoding="utf-8")
            (folder / "meta.json").write_text(json.dumps({"video_id": vid, "title": "T"}), encoding="utf-8")

    def sent(self, path):
        return [r for r in self.server.requests if r["path"] == path]

    def test_connect_e_batida_de_coracao_enviam_o_endereco_da_midia(self):
        self.server.reply({"device": {"id": "d"}, "session": None}, path="/me")
        self.server.reply({"id": "s", "display_name": "Gabriel"}, path="/sessions")
        self.b.connect()
        self.assertNotIn("media_base", self.sent("/sessions")[0]["body"])  # sem servidor local: a nuvem usa o armazenamento dela
        self.b.media_base = self.BASE
        self.assertEqual(self.b.clone().media_base, self.BASE)  # as cópias (threads) compartilham
        self.server.reply({"device": {"id": "d"}, "session": {"id": "s", "display_name": "Gabriel"}}, path="/me")
        self.server.reply({"id": "s", "display_name": "Gabriel"}, path="/sessions")
        self.b.connect(keep_name=True)
        self.assertEqual(self.sent("/sessions")[1]["body"]["media_base"], self.BASE)
        self.server.reply({"ok": True, "session_id": "s"}, path="/heartbeat")
        self.b.heartbeat()
        self.assertEqual(self.sent("/heartbeat")[0]["body"]["media_base"], self.BASE)

    def test_publica_a_musica_pronta_com_o_meta_e_os_arquivos(self):
        self.b.media_base = self.BASE
        self.song()
        self.b.publish_song("abcdefghijk")
        (req,) = self.sent("/library")
        self.assertEqual(req["method"], "PUT")
        (entry,) = req["body"]["songs"]
        self.assertEqual((entry["id"], entry["meta"]["title"]), ("abcdefghijk", "T"))
        self.assertEqual(entry["files"], {"instrumental": True, "lyrics": True, "melody": False, "backing": False, "exports": []})

    def test_sem_servidor_local_ou_musica_incompleta_nao_publica_nada(self):
        self.song()
        self.b.publish_song("abcdefghijk")  # sem media_base
        self.b.media_base = self.BASE
        self.song("bbbbbbbbbbb", ready=False)
        self.b.publish_song("bbbbbbbbbbb")  # incompleta
        self.b.publish_song("inexistente0")
        self.assertEqual(self.sent("/library"), [])

    def test_falha_de_rede_nao_derruba_o_job_e_a_proxima_batida_tenta_de_novo(self):
        self.b.media_base = self.BASE
        self.song()
        for _ in range(3):
            self.server.reply(urllib.error.URLError("sem rede"), path="/library")
        self.b.publish_song("abcdefghijk")  # nenhuma exceção
        self.assertEqual(len(self.sent("/library")), 3)
        self.assertEqual(self.b._shared.unpublished, {"abcdefghijk"})
        self.server.reply({"count": 1}, path="/library")
        self.server.reply({"ok": True, "session_id": "sess-1"}, path="/heartbeat")
        self.b.heartbeat()
        self.assertEqual(len(self.sent("/library")), 4)
        self.assertEqual(self.b._shared.unpublished, set())

    def test_servidor_recusando_o_catalogo_ou_token_revogado_tambem_nao_derrubam(self):
        self.b.media_base = self.BASE
        self.song()
        self.server.reply({"error": "invalid_library_entry"}, status=400, path="/library")
        self.b.publish_song("abcdefghijk")
        self.server.reply({"message": "revogado"}, status=401, path="/library")
        self.b.publish_song("abcdefghijk")
        self.assertEqual(self.b._shared.unpublished, {"abcdefghijk"})

    def test_publish_all_envia_em_lotes_de_50(self):
        self.b.media_base = self.BASE
        for i in range(120):
            self.song(f"m{i:010d}")
        self.assertEqual(self.b.publish_all(), 120)
        self.assertEqual([len(r["body"]["songs"]) for r in self.sent("/library")], [50, 50, 20])

    def test_publish_all_sem_servidor_local_ou_sem_musicas(self):
        self.assertEqual(self.b.publish_all(), 0)
        self.b.media_base = self.BASE
        self.assertEqual(self.b.publish_all(), 0)
        self.assertEqual(self.sent("/library"), [])

    def test_o_worker_classico_nao_tem_catalogo(self):
        redis_backend = RedisBackend("redis://x", "w", client=FakeRedisClient())
        self.assertIsNone(redis_backend.attach_storage(object()))
        self.assertIsNone(redis_backend.publish_song("abcdefghijk"))
        self.assertEqual(redis_backend.publish_all(), 0)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
