"""SQLite storage for photos and face embeddings."""
import sqlite3
from pathlib import Path

import numpy as np

DB_PATH = Path("data/facescan.db")

SCHEMA = """
CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY,
    path TEXT UNIQUE NOT NULL,
    mtime REAL NOT NULL,
    width INTEGER,
    height INTEGER,
    n_faces INTEGER DEFAULT 0
);
CREATE TABLE IF NOT EXISTS faces (
    id INTEGER PRIMARY KEY,
    photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
    bbox_x1 REAL, bbox_y1 REAL, bbox_x2 REAL, bbox_y2 REAL,
    det_score REAL,
    embedding BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_faces_photo ON faces(photo_id);
"""


def connect(db_path: Path = DB_PATH) -> sqlite3.Connection:
    db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db_path)
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")  # readers (web app) don't block the ingest writer
    conn.executescript(SCHEMA)
    return conn


def photo_is_indexed(conn: sqlite3.Connection, path: str, mtime: float) -> bool:
    row = conn.execute(
        "SELECT mtime FROM photos WHERE path = ?", (path,)
    ).fetchone()
    return row is not None and abs(row[0] - mtime) < 1e-6


def upsert_photo(conn, path: str, mtime: float, width: int, height: int) -> int:
    conn.execute("DELETE FROM photos WHERE path = ?", (path,))
    cur = conn.execute(
        "INSERT INTO photos (path, mtime, width, height) VALUES (?, ?, ?, ?)",
        (path, mtime, width, height),
    )
    return cur.lastrowid


def add_face(conn, photo_id: int, bbox, det_score: float, embedding: np.ndarray):
    emb = np.asarray(embedding, dtype=np.float32)
    emb = emb / (np.linalg.norm(emb) + 1e-10)  # store L2-normalized
    conn.execute(
        "INSERT INTO faces (photo_id, bbox_x1, bbox_y1, bbox_x2, bbox_y2, det_score, embedding)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
        (photo_id, float(bbox[0]), float(bbox[1]), float(bbox[2]), float(bbox[3]),
         float(det_score), emb.tobytes()),
    )


def set_face_count(conn, photo_id: int, n: int):
    conn.execute("UPDATE photos SET n_faces = ? WHERE id = ?", (n, photo_id))


def load_index(conn):
    """Return (embeddings [N,512] float32, face_meta list of dicts) for the whole DB."""
    rows = conn.execute(
        """SELECT f.embedding, f.photo_id, p.path, f.bbox_x1, f.bbox_y1, f.bbox_x2, f.bbox_y2
           FROM faces f JOIN photos p ON p.id = f.photo_id"""
    ).fetchall()
    if not rows:
        return np.zeros((0, 512), dtype=np.float32), []
    embs = np.frombuffer(b"".join(r[0] for r in rows), dtype=np.float32).reshape(len(rows), -1)
    meta = [
        {"photo_id": r[1], "path": r[2], "bbox": [r[3], r[4], r[5], r[6]]}
        for r in rows
    ]
    return embs, meta


def stats(conn):
    n_photos = conn.execute("SELECT COUNT(*) FROM photos").fetchone()[0]
    n_faces = conn.execute("SELECT COUNT(*) FROM faces").fetchone()[0]
    return {"photos": n_photos, "faces": n_faces}
