
from facescan import db
from facescan.index import FaceIndex

from .conftest import unit


def _seed(path, embs, db_path):
    conn = db.connect(db_path)
    pid = db.upsert_photo(conn, path, 1.0, 100, 100)
    for e in embs:
        db.add_face(conn, pid, (0, 0, 10, 10), 0.9, e)
    db.set_face_count(conn, pid, len(embs))
    conn.commit()
    conn.close()


def test_empty_index_returns_no_matches(db_path):
    idx = FaceIndex(db_path)
    idx.refresh(force=True)
    assert idx.size == 0
    assert idx.search(unit(0)) == []


def test_search_ranks_by_similarity_and_applies_threshold(db_path):
    target = unit(1)
    _seed("hit.jpg", [target], db_path)
    _seed("miss.jpg", [unit(2)], db_path)  # random 512-d vectors are near-orthogonal

    idx = FaceIndex(db_path)
    idx.refresh(force=True)
    results = idx.search(target, threshold=0.35)

    assert [r["path"] for r in results] == ["hit.jpg"]
    assert results[0]["score"] > 0.99
    assert results[0]["bbox"] == [0.0, 0.0, 10.0, 10.0]


def test_search_returns_best_face_per_photo(db_path):
    target = unit(3)
    _seed("group.jpg", [target, unit(4)], db_path)

    idx = FaceIndex(db_path)
    idx.refresh(force=True)
    results = idx.search(target, threshold=0.0)

    assert len(results) == 1
    assert results[0]["score"] > 0.99


def test_search_normalizes_the_query(db_path):
    target = unit(5)
    _seed("hit.jpg", [target], db_path)

    idx = FaceIndex(db_path)
    idx.refresh(force=True)
    scaled = idx.search(target * 12.0, threshold=0.35)

    assert len(scaled) == 1
    assert scaled[0]["score"] <= 1.001


def test_refresh_picks_up_new_faces(db_path):
    _seed("a.jpg", [unit(6)], db_path)
    idx = FaceIndex(db_path)
    idx.refresh(force=True)
    assert idx.size == 1

    _seed("b.jpg", [unit(7)], db_path)
    idx.refresh(force=True)  # forced: mtime granularity makes auto-detect flaky in tests
    assert idx.size == 2


def test_top_k_caps_results(db_path):
    target = unit(8)
    for i in range(5):
        _seed(f"p{i}.jpg", [target], db_path)

    idx = FaceIndex(db_path)
    idx.refresh(force=True)
    assert len(idx.search(target, threshold=0.0, top_k=2)) == 2
