"""Shared fixtures. Note: nothing here imports insightface — the engine is
lazy-loaded, so the API can be exercised with a stubbed detector."""
import sys
from pathlib import Path

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from facescan import db  # noqa: E402


def unit(seed: int, dim: int = 512) -> np.ndarray:
    rng = np.random.default_rng(seed)
    v = rng.standard_normal(dim).astype(np.float32)
    return v / np.linalg.norm(v)


@pytest.fixture
def db_path(tmp_path, monkeypatch):
    """A throwaway SQLite DB, installed as the default for db.connect().

    db.connect() binds DB_PATH as a default argument at import time, so callers
    that rely on the default (the web app) need connect itself redirected.
    """
    p = tmp_path / "facescan.db"
    real_connect = db.connect
    monkeypatch.setattr(db, "DB_PATH", p)
    monkeypatch.setattr(db, "connect", lambda db_path=p: real_connect(db_path))
    return p


@pytest.fixture
def conn(db_path):
    c = db.connect(db_path)
    yield c
    c.close()
