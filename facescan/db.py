"""SQLite storage for photos and face embeddings.

It doubles as the indexing queue. A photo with n_faces NULL is waiting for
face detection; whoever indexes it (the web app's own thread, or a worker
node over HTTP) first claims it with a lease, so many indexers can share one
backlog without two of them doing the same photo, and a node that dies
mid-photo hands it back when the lease runs out.
"""
import hashlib
import sqlite3
import time
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
    n_faces INTEGER DEFAULT 0,
    sha256 TEXT
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
    conn = sqlite3.connect(db_path, timeout=30)
    conn.execute("PRAGMA foreign_keys = ON")
    # Several processes (web workers, ingest) can open a fresh database at the
    # same moment. Switching to WAL and creating the schema need an exclusive
    # lock that does not always wait on the busy timeout, so retry rather
    # than fail a server's startup.
    for attempt in range(100):
        try:
            if conn.execute("PRAGMA journal_mode").fetchone()[0].lower() != "wal":
                # readers (web app) don't block the ingest writer; persists in the file
                conn.execute("PRAGMA journal_mode = WAL")
            conn.executescript(SCHEMA)
            _migrate(conn)
            return conn
        except sqlite3.OperationalError as e:
            if attempt == 99 or not ("locked" in str(e) or "busy" in str(e)):
                conn.close()
                raise
            time.sleep(0.05)
    raise AssertionError("unreachable")


def _migrate(conn: sqlite3.Connection):
    """Bring a database created by an older version up to date.

    The sha256 index lives here, not in SCHEMA: on an existing database
    CREATE TABLE IF NOT EXISTS is a no-op, so indexing a column the old table
    does not have would fail before the column could be added.
    """
    have = {r[1] for r in conn.execute("PRAGMA table_info(photos)")}
    for col, decl in (("sha256", "TEXT"), ("claimed_by", "TEXT"), ("claimed_until", "REAL"),
                      ("attempts", "INTEGER NOT NULL DEFAULT 0")):
        if col not in have:
            try:
                conn.execute(f"ALTER TABLE photos ADD COLUMN {col} {decl}")
            except sqlite3.OperationalError as e:
                if "duplicate column" not in str(e):  # another process got there first
                    raise
    conn.execute("CREATE INDEX IF NOT EXISTS idx_photos_sha ON photos(sha256)")
    conn.commit()


def file_hash(path) -> str:
    """Content hash used to recognise the same photo under a different name."""
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def photo_by_hash(conn: sqlite3.Connection, digest: str):
    """The path already indexed for this content, or None."""
    row = conn.execute(
        "SELECT path FROM photos WHERE sha256 = ? LIMIT 1", (digest,)
    ).fetchone()
    return row[0] if row else None


def photo_is_indexed(conn: sqlite3.Connection, path: str, mtime: float) -> bool:
    row = conn.execute(
        "SELECT mtime FROM photos WHERE path = ?", (path,)
    ).fetchone()
    return row is not None and abs(row[0] - mtime) < 1e-6


def upsert_photo(conn, path: str, mtime: float, width: int, height: int,
                 sha256: str | None = None) -> int:
    conn.execute("DELETE FROM photos WHERE path = ?", (path,))
    cur = conn.execute(
        "INSERT INTO photos (path, mtime, width, height, sha256) VALUES (?, ?, ?, ?, ?)",
        (path, mtime, width, height, sha256),
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
        """SELECT f.embedding, f.photo_id, p.path, f.bbox_x1, f.bbox_y1, f.bbox_x2, f.bbox_y2,
                  p.width, p.height
           FROM faces f JOIN photos p ON p.id = f.photo_id"""
    ).fetchall()
    if not rows:
        return np.zeros((0, 512), dtype=np.float32), []
    embs = np.frombuffer(b"".join(r[0] for r in rows), dtype=np.float32).reshape(len(rows), -1)
    meta = [
        {"photo_id": r[1], "path": r[2], "bbox": [r[3], r[4], r[5], r[6]], "w": r[7], "h": r[8]}
        for r in rows
    ]
    return embs, meta


def pending_photos(conn):
    """Photos accepted but never indexed (n_faces NULL): a restart resumes them."""
    rows = conn.execute(
        "SELECT path, sha256 FROM photos WHERE n_faces IS NULL ORDER BY id"
    ).fetchall()
    return [{"path": r[0], "sha256": r[1]} for r in rows]


def list_photos(conn, limit: int = 120, offset: int = 0):
    """Newest-indexed first page of photos for the gallery view."""
    rows = conn.execute(
        "SELECT id, path, width, height, n_faces FROM photos ORDER BY id DESC LIMIT ? OFFSET ?",
        (limit, offset),
    ).fetchall()
    return [
        {"id": r[0], "path": r[1], "w": r[2], "h": r[3], "n_faces": r[4]}
        for r in rows
    ]


def delete_photos(conn, ids) -> list[str]:
    """Drop photos (their faces cascade) and return the paths that were removed."""
    ids = [int(i) for i in ids]
    if not ids:
        return []
    marks = ",".join("?" * len(ids))
    paths = [r[0] for r in conn.execute(f"SELECT path FROM photos WHERE id IN ({marks})", ids)]
    conn.execute(f"DELETE FROM photos WHERE id IN ({marks})", ids)
    return paths


# --- the indexing queue -------------------------------------------------------

# A claim is open while the photo is unindexed and its lease has not run out.
_CLAIMABLE = "n_faces IS NULL AND (claimed_until IS NULL OR claimed_until < ?)"


def pending_count(conn) -> int:
    return conn.execute("SELECT COUNT(*) FROM photos WHERE n_faces IS NULL").fetchone()[0]


def claimable(conn, limit: int) -> list[dict]:
    """Waiting photos nobody holds a live lease on (e.g. a worker node died)."""
    rows = conn.execute(
        f"SELECT path, sha256 FROM photos WHERE {_CLAIMABLE} ORDER BY id LIMIT ?",
        (time.time(), limit),
    ).fetchall()
    return [{"path": r[0], "sha256": r[1]} for r in rows]


def claim_path(conn, path: str, worker: str, lease: float) -> int | None:
    """Claim one known photo; its id, or None if it is done or someone has it."""
    now = time.time()
    cur = conn.execute(
        f"UPDATE photos SET claimed_by = ?, claimed_until = ?, attempts = attempts + 1"
        f" WHERE path = ? AND {_CLAIMABLE}",
        (worker, now + lease, path, now),
    )
    conn.commit()
    if cur.rowcount != 1:
        return None
    return conn.execute("SELECT id FROM photos WHERE path = ?", (path,)).fetchone()[0]


def claim_pending(conn, worker: str, limit: int, lease: float) -> list[dict]:
    """Claim up to `limit` waiting photos, oldest first."""
    conn.commit()
    now = time.time()
    conn.execute("BEGIN IMMEDIATE")  # pick and mark in one write lock: no double claims
    try:
        rows = conn.execute(
            f"SELECT id, path, sha256 FROM photos WHERE {_CLAIMABLE} ORDER BY id LIMIT ?",
            (now, limit),
        ).fetchall()
        conn.executemany(
            "UPDATE photos SET claimed_by = ?, claimed_until = ?, attempts = attempts + 1"
            " WHERE id = ?",
            [(worker, now + lease, r[0]) for r in rows],
        )
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    return [{"id": r[0], "path": r[1], "sha256": r[2]} for r in rows]


def finish_photo(conn, photo_id: int, worker: str, width: int, height: int, faces) -> bool:
    """Store a claimed photo's faces. False if the claim was lost to another worker.

    A worker whose lease ran out may still finish first; that is fine as long
    as nobody else has claimed the photo since.
    """
    owner = conn.execute(
        "SELECT claimed_by FROM photos WHERE id = ? AND n_faces IS NULL", (photo_id,)
    ).fetchone()
    if owner is None or owner[0] not in (worker, None):
        return False
    conn.execute("DELETE FROM faces WHERE photo_id = ?", (photo_id,))
    for f in faces:
        add_face(conn, photo_id, f["bbox"], f["det_score"], f["embedding"])
    conn.execute(
        "UPDATE photos SET width = ?, height = ?, n_faces = ?, claimed_by = NULL,"
        " claimed_until = NULL WHERE id = ?",
        (width, height, len(faces), photo_id),
    )
    conn.commit()
    return True


def fail_photo(conn, photo_id: int, worker: str, max_attempts: int) -> bool:
    """Release a claim that failed. After max_attempts the photo is given up on:
    it stays in the gallery, with no faces, rather than looping forever.
    Returns True when it was given up."""
    conn.execute(
        "UPDATE photos SET claimed_by = NULL, claimed_until = NULL"
        " WHERE id = ? AND claimed_by = ? AND n_faces IS NULL",
        (photo_id, worker),
    )
    cur = conn.execute(
        "UPDATE photos SET n_faces = 0 WHERE id = ? AND n_faces IS NULL AND attempts >= ?",
        (photo_id, max_attempts),
    )
    conn.commit()
    return cur.rowcount == 1


def stats(conn):
    n_photos = conn.execute("SELECT COUNT(*) FROM photos").fetchone()[0]
    n_faces = conn.execute("SELECT COUNT(*) FROM faces").fetchone()[0]
    return {"photos": n_photos, "faces": n_faces}
