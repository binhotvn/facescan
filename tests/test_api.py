"""End-to-end API tests with the face detector stubbed out (no model download)."""
import io
from types import SimpleNamespace

import numpy as np
import pytest
from fastapi.testclient import TestClient

from facescan import db
from facescan.index import FaceIndex

from .conftest import unit

cv2 = pytest.importorskip("cv2")
import app as app_module  # noqa: E402


@pytest.fixture
def photos_dir(tmp_path, monkeypatch):
    d = tmp_path / "photos"
    d.mkdir()
    monkeypatch.setattr(app_module, "PHOTOS_DIR", d.resolve())
    monkeypatch.setattr(app_module, "THUMBS_DIR", (tmp_path / "thumbs").resolve())
    return d


@pytest.fixture
def client(db_path, photos_dir, monkeypatch):
    monkeypatch.setattr(app_module, "index", FaceIndex(db_path))
    with TestClient(app_module.app) as c:
        yield c


def _jpeg_bytes(w=64, h=64) -> bytes:
    img = np.full((h, w, 3), 128, dtype=np.uint8)
    ok, buf = cv2.imencode(".jpg", img)
    assert ok
    return buf.tobytes()


def _seed_face(db_path, path: str, emb):
    conn = db.connect(db_path)
    pid = db.upsert_photo(conn, path, 1.0, 64, 64)
    db.add_face(conn, pid, (1, 2, 3, 4), 0.99, emb)
    db.set_face_count(conn, pid, 1)
    conn.commit()
    conn.close()


def test_healthz(client):
    r = client.get("/healthz")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["faces_indexed"] == 0


def test_stats(client, db_path):
    _seed_face(db_path, "a.jpg", unit(1))
    assert client.get("/api/stats").json() == {"photos": 1, "faces": 1}


def test_refresh_reloads_index(client, db_path):
    assert client.post("/api/refresh").json() == {"faces_indexed": 0}
    _seed_face(db_path, "a.jpg", unit(2))
    assert client.post("/api/refresh").json() == {"faces_indexed": 1}


def test_search_returns_matches(client, db_path, monkeypatch, photos_dir):
    target = unit(3)
    photo = photos_dir / "a.jpg"
    photo.write_bytes(_jpeg_bytes())
    _seed_face(db_path, str(photo), target)
    client.post("/api/refresh")
    monkeypatch.setattr(
        app_module, "detect_query_face",
        lambda img: SimpleNamespace(normed_embedding=target),
    )

    r = client.post("/api/search", files={"file": ("selfie.jpg", _jpeg_bytes(), "image/jpeg")})

    assert r.status_code == 200
    matches = r.json()["matches"]
    assert len(matches) == 1
    assert matches[0]["score"] >= 0.99
    assert matches[0]["url"].startswith("/photo?path=")
    assert matches[0]["thumb"].endswith("&thumb=1")


def test_search_without_a_face_is_422(client, monkeypatch):
    monkeypatch.setattr(app_module, "detect_query_face", lambda img: None)
    r = client.post("/api/search", files={"file": ("selfie.jpg", _jpeg_bytes(), "image/jpeg")})
    assert r.status_code == 422


def test_search_rejects_undecodable_upload(client):
    r = client.post("/api/search", files={"file": ("x.jpg", b"not an image", "image/jpeg")})
    assert r.status_code == 400


def test_search_rejects_oversized_upload(client, monkeypatch):
    monkeypatch.setattr(app_module, "MAX_UPLOAD_BYTES", 10)
    payload = io.BytesIO(b"x" * 64)
    r = client.post("/api/search", files={"file": ("big.jpg", payload, "image/jpeg")})
    assert r.status_code == 413


def test_search_threshold_is_validated(client):
    r = client.post(
        "/api/search?threshold=5",
        files={"file": ("selfie.jpg", _jpeg_bytes(), "image/jpeg")},
    )
    assert r.status_code == 422


def test_photo_serves_files_inside_photos_dir(client, photos_dir):
    photo = photos_dir / "a.jpg"
    photo.write_bytes(_jpeg_bytes())
    r = client.get("/photo", params={"path": str(photo)})
    assert r.status_code == 200


def test_photo_generates_a_thumbnail(client, photos_dir):
    photo = photos_dir / "big.jpg"
    photo.write_bytes(_jpeg_bytes(1200, 900))
    r = client.get("/photo", params={"path": str(photo), "thumb": "1"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/jpeg"
    thumb = cv2.imdecode(np.frombuffer(r.content, np.uint8), cv2.IMREAD_COLOR)
    assert max(thumb.shape[:2]) == 480


def test_photo_rejects_paths_outside_photos_dir(client, tmp_path):
    outside = tmp_path / "secret.jpg"
    outside.write_bytes(_jpeg_bytes())
    assert client.get("/photo", params={"path": str(outside)}).status_code == 404
    assert client.get("/photo", params={"path": "/etc/passwd"}).status_code == 404
