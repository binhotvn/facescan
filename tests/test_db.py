import numpy as np

from facescan import db

from .conftest import unit


def test_connect_upgrades_a_database_from_an_older_version(tmp_path):
    """A pre-sha256 database must open, keep its rows, and gain the column.

    Regression: the sha256 index lived in SCHEMA, and CREATE TABLE IF NOT
    EXISTS leaves an old table alone, so startup died with
    "no such column: sha256" on every existing deployment.
    """
    import sqlite3

    path = tmp_path / "legacy.db"
    old = sqlite3.connect(path)
    old.executescript(
        """
        CREATE TABLE photos (id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL,
                             mtime REAL NOT NULL, width INTEGER, height INTEGER,
                             n_faces INTEGER DEFAULT 0);
        CREATE TABLE faces (id INTEGER PRIMARY KEY,
                            photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
                            bbox_x1 REAL, bbox_y1 REAL, bbox_x2 REAL, bbox_y2 REAL,
                            det_score REAL, embedding BLOB NOT NULL);
        """
    )
    old.execute("INSERT INTO photos (path, mtime, width, height) VALUES ('a.jpg', 1.0, 10, 10)")
    old.commit()
    old.close()

    conn = db.connect(path)

    assert "sha256" in {r[1] for r in conn.execute("PRAGMA table_info(photos)")}
    assert db.stats(conn) == {"photos": 1, "faces": 0}  # existing data untouched
    conn.close()

    db.connect(path).close()  # and connecting again is a no-op, not an error


def test_schema_and_stats_empty(conn):
    assert db.stats(conn) == {"photos": 0, "faces": 0}
    embs, meta = db.load_index(conn)
    assert embs.shape == (0, 512)
    assert meta == []


def test_upsert_photo_replaces_by_path(conn):
    first = db.upsert_photo(conn, "a.jpg", 1.0, 100, 200)
    db.add_face(conn, first, (0, 0, 10, 10), 0.9, unit(1))
    db.upsert_photo(conn, "a.jpg", 2.0, 100, 200)

    assert db.photo_is_indexed(conn, "a.jpg", 2.0)
    assert db.stats(conn) == {"photos": 1, "faces": 0}  # faces cascade-deleted


def test_photo_is_indexed_tracks_mtime(conn):
    db.upsert_photo(conn, "a.jpg", 1.5, 10, 10)
    assert db.photo_is_indexed(conn, "a.jpg", 1.5)
    assert not db.photo_is_indexed(conn, "a.jpg", 2.5)
    assert not db.photo_is_indexed(conn, "missing.jpg", 1.5)


def test_embeddings_are_stored_normalized(conn):
    pid = db.upsert_photo(conn, "a.jpg", 1.0, 10, 10)
    db.add_face(conn, pid, (1, 2, 3, 4), 0.8, unit(2) * 7.0)  # unnormalized input
    db.set_face_count(conn, pid, 1)

    embs, meta = db.load_index(conn)
    assert embs.shape == (1, 512)
    assert np.isclose(np.linalg.norm(embs[0]), 1.0, atol=1e-5)
    assert meta[0]["path"] == "a.jpg"
    assert meta[0]["bbox"] == [1.0, 2.0, 3.0, 4.0]
    assert db.stats(conn) == {"photos": 1, "faces": 1}
