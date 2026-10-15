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


def test_albums_list_in_order_with_their_photo_counts(conn):
    gala = db.create_album(conn, "Gala Dinner")
    opening = db.create_album(conn, "Lễ Khai Mạc")
    pid = db.upsert_photo(conn, "a.jpg", 1.0, 10, 10, album_id=gala["id"])
    db.upsert_photo(conn, "b.jpg", 1.0, 10, 10)
    conn.commit()

    assert [(a["name"], a["photos"]) for a in db.list_albums(conn)] == [
        ("Gala Dinner", 1), ("Lễ Khai Mạc", 0)]
    assert [p["id"] for p in db.list_photos(conn, album=gala["id"])] == [pid]
    assert db.count_photos(conn, 0) == 1  # 0: the photos in no album
    assert db.count_photos(conn) == 2

    db.order_albums(conn, [opening["id"]])  # the one not listed keeps its place, after
    assert [a["name"] for a in db.list_albums(conn)] == ["Lễ Khai Mạc", "Gala Dinner"]


def test_album_names_are_unique_ignoring_case(conn):
    album = db.create_album(conn, "Lễ Trao Giải")
    assert db.create_album(conn, "lễ trao giải") is None
    other = db.create_album(conn, "Signature")
    assert db.rename_album(conn, other["id"], "LỄ TRAO GIẢI") == "taken"
    assert db.rename_album(conn, album["id"], "Lễ trao giải") == "ok"  # its own name, recased
    assert db.rename_album(conn, 999, "x") == "missing"


def test_deleting_an_album_keeps_its_photos(conn):
    album = db.create_album(conn, "Behind The Scenes")
    db.upsert_photo(conn, "a.jpg", 1.0, 10, 10, album_id=album["id"])
    conn.commit()

    assert db.delete_album(conn, album["id"]) == 1
    assert db.list_albums(conn) == []
    assert [p["album"] for p in db.list_photos(conn)] == [None]
    assert db.delete_album(conn, album["id"]) is None


def test_reindexing_a_photo_keeps_its_album(conn):
    album = db.create_album(conn, "Best Gross")
    db.upsert_photo(conn, "a.jpg", 1.0, 10, 10, album_id=album["id"])
    db.upsert_photo(conn, "a.jpg", 2.0, 10, 10)  # what ingest --force does
    conn.commit()
    assert db.list_photos(conn)[0]["album"] == album["id"]


def test_older_database_gains_albums(tmp_path):
    import sqlite3

    path = tmp_path / "legacy.db"
    old = sqlite3.connect(path)
    old.execute("CREATE TABLE photos (id INTEGER PRIMARY KEY, path TEXT UNIQUE NOT NULL,"
                " mtime REAL NOT NULL, width INTEGER, height INTEGER, n_faces INTEGER DEFAULT 0)")
    old.execute("INSERT INTO photos (path, mtime) VALUES ('a.jpg', 1.0)")
    old.commit()
    old.close()

    conn = db.connect(path)
    album = db.create_album(conn, "Gala Dinner")
    assert db.set_album(conn, [1], album["id"]) == 1
    assert db.list_albums(conn)[0]["photos"] == 1
    conn.close()
