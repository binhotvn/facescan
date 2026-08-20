"""End-to-end API tests with the face detector stubbed out (no model download)."""
import io
import zipfile
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
    body = client.get("/api/stats").json()
    assert (body["photos"], body["faces"]) == (1, 1)
    assert body["event"]["name"]  # event header copy, overridable via env


def test_photos_lists_the_gallery(client, db_path, photos_dir):
    for name in ("a.jpg", "b.jpg"):
        (photos_dir / name).write_bytes(_jpeg_bytes())
        _seed_face(db_path, str(photos_dir / name), unit(9))

    body = client.get("/api/photos").json()

    assert body["total"] == 2
    assert len(body["photos"]) == 2
    assert all(p["faces"] == 1 for p in body["photos"])
    assert all(p["thumb"].endswith("&size=sm") for p in body["photos"])
    assert all(p["medium"].endswith("&size=md") for p in body["photos"])
    assert all(p["w"] == 64 and p["h"] == 64 for p in body["photos"])
    assert all(isinstance(p["id"], int) for p in body["photos"])


def test_photos_paginates(client, db_path, photos_dir):
    for i in range(3):
        _seed_face(db_path, str(photos_dir / f"p{i}.jpg"), unit(10 + i))

    page = client.get("/api/photos", params={"limit": 2, "offset": 0}).json()
    rest = client.get("/api/photos", params={"limit": 2, "offset": 2}).json()

    assert page["total"] == 3
    assert len(page["photos"]) == 2
    assert len(rest["photos"]) == 1
    assert {p["url"] for p in page["photos"]}.isdisjoint({p["url"] for p in rest["photos"]})


def test_photo_urls_are_percent_encoded(client, db_path, photos_dir):
    _seed_face(db_path, str(photos_dir / "ch\u1ea1y b\u1ed9.jpg"), unit(13))
    url = client.get("/api/photos").json()["photos"][0]["url"]
    assert " " not in url and "%20" in url


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
    assert matches[0]["thumb"].endswith("&size=sm")
    assert (matches[0]["w"], matches[0]["h"]) == (64, 64)


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


def test_photo_sizes_cap_the_long_edge(client, photos_dir):
    photo = photos_dir / "big.jpg"
    photo.write_bytes(_jpeg_bytes(3000, 2000))

    for size, edge in (("sm", 480), ("md", 1600)):
        r = client.get("/photo", params={"path": str(photo), "size": size})
        assert r.status_code == 200
        img = cv2.imdecode(np.frombuffer(r.content, np.uint8), cv2.IMREAD_COLOR)
        assert max(img.shape[:2]) == edge

    full = client.get("/photo", params={"path": str(photo), "size": "full"})
    img = cv2.imdecode(np.frombuffer(full.content, np.uint8), cv2.IMREAD_COLOR)
    assert max(img.shape[:2]) == 3000


def test_thumb_flag_still_means_sm(client, photos_dir):
    photo = photos_dir / "big.jpg"
    photo.write_bytes(_jpeg_bytes(1200, 900))
    legacy = client.get("/photo", params={"path": str(photo), "thumb": "1"})
    sized = client.get("/photo", params={"path": str(photo), "size": "sm"})
    assert legacy.content == sized.content


def test_photo_rejects_an_unknown_size(client, photos_dir):
    photo = photos_dir / "a.jpg"
    photo.write_bytes(_jpeg_bytes())
    assert client.get("/photo", params={"path": str(photo), "size": "huge"}).status_code == 422


def test_download_flag_sets_attachment(client, photos_dir):
    photo = photos_dir / "a.jpg"
    photo.write_bytes(_jpeg_bytes())
    r = client.get("/photo", params={"path": str(photo), "download": "1"})
    assert "attachment" in r.headers["content-disposition"]
    assert "a.jpg" in r.headers["content-disposition"]


# --- upload -----------------------------------------------------------------


@pytest.fixture
def upload_ready(monkeypatch, photos_dir):
    """Enable uploads and stub the face pass (no model in CI)."""
    monkeypatch.setattr(app_module, "UPLOAD_TOKEN", "s3cret")

    def fake_process(path):
        img = cv2.imread(path)
        h, w = img.shape[:2]
        return {
            "path": path,
            "width": w,
            "height": h,
            "faces": [{"bbox": [1, 2, 3, 4], "det_score": 0.9, "embedding": unit(21)}],
        }

    monkeypatch.setattr(app_module.ingest, "_process_one", fake_process)
    return photos_dir / "uploads"


def _upload(client, files, token="s3cret"):
    headers = {"X-Upload-Token": token} if token else {}
    return client.post("/api/upload", files=files, headers=headers)


def test_upload_indexes_the_photo(client, upload_ready):
    r = _upload(client, [("files", ("race.jpg", _jpeg_bytes(), "image/jpeg"))])

    assert r.status_code == 200
    body = r.json()
    assert (body["indexed"], body["faces"]) == (1, 1)
    assert body["photos"][0]["ok"] is True
    assert list(upload_ready.iterdir())  # written under photos/uploads

    gallery = client.get("/api/photos").json()
    assert gallery["total"] == 1
    assert client.get("/api/stats").json()["faces"] == 1


def test_upload_accepts_a_batch(client, upload_ready):
    files = [("files", (f"p{i}.jpg", _jpeg_bytes(), "image/jpeg")) for i in range(3)]
    assert _upload(client, files).json()["indexed"] == 3
    assert client.get("/api/photos").json()["total"] == 3


def test_upload_requires_the_token(client, upload_ready):
    files = [("files", ("a.jpg", _jpeg_bytes(), "image/jpeg"))]
    assert _upload(client, files, token=None).status_code == 401
    assert _upload(client, files, token="wrong").status_code == 401
    assert not upload_ready.exists()


def test_upload_is_disabled_without_a_configured_token(client, monkeypatch):
    monkeypatch.setattr(app_module, "UPLOAD_TOKEN", "")
    r = _upload(client, [("files", ("a.jpg", _jpeg_bytes(), "image/jpeg"))], token="anything")
    assert r.status_code == 503


def test_upload_reports_unreadable_files_without_failing_the_batch(client, upload_ready):
    files = [
        ("files", ("good.jpg", _jpeg_bytes(), "image/jpeg")),
        ("files", ("bad.jpg", b"not an image", "image/jpeg")),
    ]
    body = _upload(client, files).json()

    assert body["indexed"] == 1
    assert [p["ok"] for p in body["photos"]] == [True, False]


def test_upload_rejects_oversized_files(client, upload_ready, monkeypatch):
    monkeypatch.setattr(app_module, "MAX_PHOTO_BYTES", 10)
    body = _upload(client, [("files", ("big.jpg", _jpeg_bytes(), "image/jpeg"))]).json()
    assert body["indexed"] == 0
    assert body["photos"][0]["error"]


def test_upload_rejects_an_oversized_batch(client, upload_ready, monkeypatch):
    monkeypatch.setattr(app_module, "MAX_UPLOAD_BATCH", 2)
    files = [("files", (f"p{i}.jpg", _jpeg_bytes(), "image/jpeg")) for i in range(3)]
    assert _upload(client, files).status_code == 413


def test_upload_neutralizes_hostile_filenames(client, upload_ready):
    files = [("files", ("../../../etc/passwd.jpg", _jpeg_bytes(), "image/jpeg"))]
    body = _upload(client, files).json()

    assert body["indexed"] == 1
    written = list(upload_ready.iterdir())
    assert len(written) == 1
    assert ".." not in written[0].name
    assert written[0].parent == upload_ready  # never escaped the uploads folder


def test_upload_names_do_not_collide(client, upload_ready):
    files = [("files", ("same.jpg", _jpeg_bytes(), "image/jpeg")) for _ in range(2)]
    assert _upload(client, files).json()["indexed"] == 2
    assert len(list(upload_ready.iterdir())) == 2


def test_download_zip_bundles_the_photos(client, photos_dir):
    paths = []
    for name in ("a.jpg", "b.jpg"):
        (photos_dir / name).write_bytes(_jpeg_bytes())
        paths.append(str(photos_dir / name))

    r = client.post("/api/download-zip", json={"paths": paths})

    assert r.status_code == 200
    assert "attachment" in r.headers["content-disposition"]
    with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
        assert sorted(zf.namelist()) == ["a.jpg", "b.jpg"]
        assert zf.read("a.jpg") == (photos_dir / "a.jpg").read_bytes()


def test_download_zip_deduplicates_filenames(client, photos_dir):
    (photos_dir / "sub").mkdir()
    for p in (photos_dir / "a.jpg", photos_dir / "sub" / "a.jpg"):
        p.write_bytes(_jpeg_bytes())

    r = client.post(
        "/api/download-zip",
        json={"paths": [str(photos_dir / "a.jpg"), str(photos_dir / "sub" / "a.jpg")]},
    )

    with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
        assert sorted(zf.namelist()) == ["a-1.jpg", "a.jpg"]


def test_download_zip_rejects_paths_outside_photos_dir(client, photos_dir, tmp_path):
    (photos_dir / "a.jpg").write_bytes(_jpeg_bytes())
    outside = tmp_path / "secret.jpg"
    outside.write_bytes(_jpeg_bytes())

    r = client.post(
        "/api/download-zip",
        json={"paths": [str(photos_dir / "a.jpg"), str(outside)]},
    )

    assert r.status_code == 404
    assert client.post("/api/download-zip", json={"paths": ["/etc/passwd"]}).status_code == 404


def test_download_zip_rejects_empty_and_oversized_requests(client, photos_dir):
    assert client.post("/api/download-zip", json={"paths": []}).status_code == 400
    too_many = [str(photos_dir / "a.jpg")] * 201
    assert client.post("/api/download-zip", json={"paths": too_many}).status_code == 413


def test_photo_rejects_paths_outside_photos_dir(client, tmp_path):
    outside = tmp_path / "secret.jpg"
    outside.write_bytes(_jpeg_bytes())
    assert client.get("/photo", params={"path": str(outside)}).status_code == 404
    assert client.get("/photo", params={"path": "/etc/passwd"}).status_code == 404
