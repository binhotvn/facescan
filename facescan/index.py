"""In-memory face index with optional FAISS acceleration.

Loads all embeddings from SQLite once, keeps them in RAM, and auto-reloads
when the database file changes (new ingest run). Brute-force numpy handles
~1M faces in well under a second; installing faiss-cpu upgrades search to an
inner-product FAISS index transparently.
"""
import logging
import threading
from pathlib import Path

import numpy as np

from . import db

log = logging.getLogger("facescan.index")

try:
    import faiss  # optional: pip install faiss-cpu
    HAVE_FAISS = True
except ImportError:
    faiss = None
    HAVE_FAISS = False


class FaceIndex:
    def __init__(self, db_path: Path = db.DB_PATH):
        self.db_path = Path(db_path)
        self._lock = threading.Lock()
        self._embs = np.zeros((0, 512), dtype=np.float32)
        self._meta = []
        self._faiss = None
        self._db_mtime = -1.0

    def _db_changed(self) -> bool:
        try:
            return self.db_path.stat().st_mtime != self._db_mtime
        except FileNotFoundError:
            return self._db_mtime != -1.0

    def refresh(self, force: bool = False):
        with self._lock:
            if not force and not self._db_changed():
                return
            conn = db.connect(self.db_path)
            embs, meta = db.load_index(conn)
            conn.close()
            self._embs, self._meta = embs, meta
            self._db_mtime = self.db_path.stat().st_mtime if self.db_path.exists() else -1.0
            if HAVE_FAISS and len(meta) > 0:
                idx = faiss.IndexFlatIP(embs.shape[1])
                idx.add(np.ascontiguousarray(embs))
                self._faiss = idx
            else:
                self._faiss = None
            log.info("index loaded: %d faces (faiss=%s)", len(meta), self._faiss is not None)

    def search(self, query_emb: np.ndarray, threshold: float = 0.35, top_k: int = 500):
        """Return list of {path, score, bbox}, best face per photo, sorted by score desc."""
        self.refresh()
        with self._lock:
            embs, meta, findex = self._embs, self._meta, self._faiss
        if len(meta) == 0:
            return []
        q = np.asarray(query_emb, dtype=np.float32)
        q = q / (np.linalg.norm(q) + 1e-10)

        if findex is not None:
            k = min(top_k, len(meta))
            scores, ids = findex.search(q[None, :], k)
            pairs = [(int(i), float(s)) for i, s in zip(ids[0], scores[0]) if s >= threshold]
        else:
            scores = embs @ q
            hit = np.where(scores >= threshold)[0]
            order = hit[np.argsort(-scores[hit])][:top_k]
            pairs = [(int(i), float(scores[i])) for i in order]

        best = {}
        for i, s in pairs:
            m = meta[i]
            if m["path"] not in best or s > best[m["path"]]["score"]:
                best[m["path"]] = {"path": m["path"], "score": s, "bbox": m["bbox"]}
        return sorted(best.values(), key=lambda r: -r["score"])

    @property
    def size(self) -> int:
        return len(self._meta)
