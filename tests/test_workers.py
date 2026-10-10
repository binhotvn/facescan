"""Distributed indexing: the claim/lease queue in the database, the hub's
worker API, and worker.py's loop driven against that API."""
import base64
import threading
import time

import numpy as np
import pytest
from fastapi.testclient import TestClient

from facescan import db
from facescan.index import FaceIndex

from .conftest import unit

cv2 = pytest.importorskip("cv2")
import app as app_module  # noqa: E402
import worker  # noqa: E402

TOKEN = {"X-Worker-Token": "w0rker"}


def _pending_photo(conn, path: str) -> int:
    pid = db.upsert_photo(conn, path, 1.0, 64, 64, sha256=path)
    conn.execute("UPDATE photos SET n_faces = NULL WHERE id = ?", (pid,))
    conn.commit()
    return pid


def _face(seed=1):
    return {"bbox": [1, 2, 3, 4], "det_score": 0.9, "embedding": unit(seed)}


# --- the queue ----------------------------------------------------------------


def test_claims_never_overlap(conn):
    for i in range(10):
        _pending_photo(conn, f"/p/{i}.jpg")
    a = db.claim_pending(conn, "a", 4, lease=60)
    b = db.claim_pending(conn, "b", 4, lease=60)
    c = db.claim_pending(conn, "c", 4, lease=60)
    ids = [j["id"] for j in a + b + c]
    assert len(ids) == len(set(ids)) == 10
    assert db.claim_pending(conn, "d", 4, lease=60) == []


def test_concurrent_claimers_split_the_backlog(db_path):
    conn = db.connect(db_path)
    for i in range(60):
        _pending_photo(conn, f"/p/{i}.jpg")
    conn.close()
    got, lock = [], threading.Lock()

    def claimer(name):
        c = db.connect(db_path)
        while jobs := db.claim_pending(c, name, 3, lease=60):
            with lock:
                got.extend(j["id"] for j in jobs)
        c.close()

    threads = [threading.Thread(target=claimer, args=(f"w{i}",)) for i in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sorted(got) == sorted(set(got)) and len(got) == 60


def test_an_expired_lease_is_claimable_again(conn):
    _pending_photo(conn, "/p/a.jpg")
    assert db.claim_pending(conn, "dead", 1, lease=-1)  # already expired
    assert [j["path"] for j in db.claim_pending(conn, "alive", 1, lease=60)] == ["/p/a.jpg"]


def test_a_lost_claim_cannot_overwrite(conn):
    pid = _pending_photo(conn, "/p/a.jpg")
    db.claim_pending(conn, "slow", 1, lease=-1)
    db.claim_pending(conn, "fast", 1, lease=60)
    assert db.finish_photo(conn, pid, "fast", 64, 64, [_face()])
    assert not db.finish_photo(conn, pid, "slow", 64, 64, [_face(), _face(2)])
    assert db.stats(conn)["faces"] == 1


def test_a_late_finish_still_counts_if_nobody_took_over(conn):
    pid = _pending_photo(conn, "/p/a.jpg")
    db.claim_pending(conn, "slow", 1, lease=-1)
    assert db.finish_photo(conn, pid, "slow", 64, 64, [_face()])
    assert db.pending_count(conn) == 0


def test_repeated_failures_give_up_without_hiding_the_photo(conn):
    pid = _pending_photo(conn, "/p/bad.jpg")
    for attempt in range(1, 4):
        assert db.claim_pending(conn, "w", 1, lease=60)
        assert db.fail_photo(conn, pid, "w", max_attempts=3) is (attempt == 3)
    assert db.pending_count(conn) == 0
    assert db.list_photos(conn)[0]["n_faces"] == 0  # still in the gallery


# --- the hub's worker API -------------------------------------------------------


@pytest.fixture
def hub(db_path, tmp_path, monkeypatch):
    photos = tmp_path / "photos"
    (photos / "uploads").mkdir(parents=True)
    monkeypatch.setattr(app_module, "PHOTOS_DIR", photos.resolve())
    monkeypatch.setattr(app_module, "THUMBS_DIR", (tmp_path / "thumbs").resolve())
    monkeypatch.setattr(app_module, "index", FaceIndex(db_path))
    monkeypatch.setattr(app_module, "UPLOAD_TOKEN", "upl0ad")
    monkeypatch.setattr(app_module, "WORKER_TOKEN", "w0rker")
    # a pure hub: everything uploaded waits for worker nodes
    monkeypatch.setattr(app_module, "LOCAL_INDEXING", False)
    with TestClient(app_module.app) as c:
        yield c


def _upload(client, n):
    files = []
    for i in range(n):
        ok, buf = cv2.imencode(".jpg", np.full((40, 60, 3), 20 + i * 30, np.uint8))
        files.append(("files", (f"p{i}.jpg", buf.tobytes(), "image/jpeg")))
    r = client.post("/api/upload", files=files, headers={"X-Upload-Token": "upl0ad"})
    assert r.json()["accepted"] == n


def _b64(v):
    return base64.b64encode(np.asarray(v, dtype="<f4").tobytes()).decode()


def test_pure_hub_leaves_uploads_for_workers(hub):
    _upload(hub, 2)
    time.sleep(0.1)
    assert hub.get("/api/stats").json()["pending"] == 2


def test_worker_round_trip(hub):
    _upload(hub, 1)
    jobs = hub.post("/api/worker/claim", json={"worker": "n1", "limit": 5}, headers=TOKEN).json()["jobs"]
    assert len(jobs) == 1
    img = hub.get(jobs[0]["photo"], headers=TOKEN)
    assert img.status_code == 200 and img.content[:2] == b"\xff\xd8"

    r = hub.post("/api/worker/result", headers=TOKEN, json={
        "id": jobs[0]["id"], "worker": "n1", "width": 60, "height": 40,
        "faces": [{"bbox": [1, 2, 3, 4], "det_score": 0.9, "embedding": _b64(unit(7))}],
    })
    assert r.json() == {"stored": True}
    stats = hub.get("/api/stats").json()
    assert stats["pending"] == 0 and stats["faces"] == 1


def test_worker_endpoints_need_a_token(hub):
    _upload(hub, 1)
    bad = {"X-Worker-Token": "nope"}
    assert hub.post("/api/worker/claim", json={"worker": "x"}, headers=bad).status_code == 401
    assert hub.post("/api/worker/claim", json={"worker": "x"}).status_code == 401
    assert hub.get("/api/worker/photo/1").status_code == 401


def test_the_upload_token_also_runs_a_worker(hub):
    """A photographer's laptop indexes the backlog with the one code it has."""
    _upload(hub, 1)
    r = hub.post("/api/worker/claim", json={"worker": "laptop"}, headers={"X-Worker-Token": "upl0ad"})
    assert len(r.json()["jobs"]) == 1


def test_worker_results_from_another_model_are_refused(hub, monkeypatch):
    monkeypatch.setattr(app_module, "_client_signature", lambda: "sig")
    _upload(hub, 1)
    job = hub.post("/api/worker/claim", json={"worker": "n1"}, headers=TOKEN).json()["jobs"][0]
    body = {"id": job["id"], "worker": "n1", "width": 60, "height": 40, "faces": [
        {"bbox": [1, 2, 3, 4], "det_score": 0.9, "embedding": _b64(unit(7))}]}
    r = hub.post("/api/worker/result", headers=TOKEN, json={**body, "signature": "old-model"})
    assert r.json()["stored"] is False
    assert hub.get("/api/stats").json()["pending"] == 1  # still waiting for a real index
    # released: another claim gets it, and a matching signature is stored
    job = hub.post("/api/worker/claim", json={"worker": "n1"}, headers=TOKEN).json()["jobs"][0]
    r = hub.post("/api/worker/result", headers=TOKEN, json={**body, "id": job["id"], "signature": "sig"})
    assert r.json() == {"stored": True}


def test_worker_result_rejects_malformed_embeddings(hub):
    _upload(hub, 1)
    job = hub.post("/api/worker/claim", json={"worker": "n1"}, headers=TOKEN).json()["jobs"][0]
    for emb in (_b64(np.ones(10)), "not base64!!", _b64(np.full(512, np.nan))):
        r = hub.post("/api/worker/result", headers=TOKEN, json={
            "id": job["id"], "worker": "n1", "width": 1, "height": 1,
            "faces": [{"bbox": [1, 2, 3, 4], "det_score": 0.9, "embedding": emb}],
        })
        assert r.status_code == 422
    assert hub.get("/api/stats").json()["pending"] == 1


def test_another_workers_result_is_not_stored(hub):
    _upload(hub, 1)
    job = hub.post("/api/worker/claim", json={"worker": "n1"}, headers=TOKEN).json()["jobs"][0]
    r = hub.post("/api/worker/result", headers=TOKEN, json={
        "id": job["id"], "worker": "intruder", "width": 1, "height": 1, "faces": [],
    })
    assert r.json() == {"stored": False}


def test_local_indexer_skips_photos_a_worker_holds(hub, db_path, monkeypatch):
    _upload(hub, 1)
    hub.post("/api/worker/claim", json={"worker": "n1"}, headers=TOKEN)
    monkeypatch.setattr(app_module, "LOCAL_INDEXING", True)
    calls = []
    monkeypatch.setattr(app_module.ingest, "_process_one", lambda p: calls.append(p))
    local = app_module.Indexer()
    assert local.resume() == 1
    local.q.join()
    local.stop()
    assert calls == []  # the worker node has it


# --- worker.py against the hub ----------------------------------------------------


class ClientHub(worker.Hub):
    """worker.Hub speaking to the TestClient instead of the network."""

    def __init__(self, client):
        super().__init__("http://hub", "w0rker")
        self.client = client

    def _call(self, method, path, body=None, raw=False):
        r = self.client.request(method, path, json=body, headers=TOKEN)
        r.raise_for_status()
        return r.content if raw else r.json()


def test_worker_loop_indexes_the_whole_backlog(hub):
    _upload(hub, 5)

    def fake_model(data):
        img = cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)
        return {"width": img.shape[1], "height": img.shape[0],
                "faces": [{"bbox": [1, 2, 3, 4], "det_score": 0.9,
                           "embedding": unit(int(img[0, 0, 0]))}]}

    assert worker.run(ClientHub(hub), "t1", batch=2, once=True, process=fake_model) == 5
    stats = hub.get("/api/stats").json()
    assert stats["pending"] == 0 and stats["faces"] == 5


def test_worker_reports_unreadable_photos(hub, monkeypatch):
    monkeypatch.setattr(app_module, "MAX_ATTEMPTS", 1)
    _upload(hub, 1)
    assert worker.run(ClientHub(hub), "t1", batch=1, once=True, process=lambda data: None) == 0
    assert hub.get("/api/stats").json()["pending"] == 0  # given up, not retried forever


def test_worker_main_requires_a_token(monkeypatch, tmp_path, capsys):
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("FACESCAN_WORKER_TOKEN", raising=False)
    monkeypatch.delenv("FACESCAN_UPLOAD_TOKEN", raising=False)
    monkeypatch.setattr(worker, "load_dotenv", lambda *p: {})
    assert worker.main(["--url", "http://x"]) == 2


def test_many_processes_can_open_a_fresh_database_at_once(tmp_path):
    """Web workers start together; none may die on the one-time setup."""
    import multiprocessing as mp

    path = tmp_path / "fresh.db"
    ctx = mp.get_context("spawn")
    procs = [ctx.Process(target=_open_db, args=(str(path),)) for _ in range(6)]
    for p in procs:
        p.start()
    for p in procs:
        p.join(60)
    assert [p.exitcode for p in procs] == [0] * 6
    conn = db.connect(path)
    cols = {r[1] for r in conn.execute("PRAGMA table_info(photos)")}
    assert {"sha256", "claimed_by", "claimed_until", "attempts"} <= cols
    conn.close()


def _open_db(path):
    from pathlib import Path

    from facescan import db as fdb

    fdb.connect(Path(path)).close()
