"""Shared fixtures. Note: nothing here imports insightface — the engine is
lazy-loaded, so the API can be exercised with a stubbed detector.

numpy and facescan are imported inside the helpers rather than at module
scope: pytest loads this file for every run, and the upload.py client is
tested on a bare Python 3.9 with nothing but pytest installed.
"""
from __future__ import annotations

import sys
from pathlib import Path
from typing import TYPE_CHECKING

import pytest

if TYPE_CHECKING:
    import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def unit(seed: int, dim: int = 512) -> np.ndarray:
    import numpy as np

    rng = np.random.default_rng(seed)
    v = rng.standard_normal(dim).astype(np.float32)
    return v / np.linalg.norm(v)


@pytest.fixture
def db_path(tmp_path, monkeypatch):
    """A throwaway SQLite DB, installed as the default for db.connect().

    db.connect() binds DB_PATH as a default argument at import time, so callers
    that rely on the default (the web app) need connect itself redirected.
    """
    from facescan import db

    p = tmp_path / "facescan.db"
    real_connect = db.connect
    monkeypatch.setattr(db, "DB_PATH", p)
    monkeypatch.setattr(db, "connect", lambda db_path=p: real_connect(db_path))
    return p


@pytest.fixture
def conn(db_path):
    from facescan import db

    c = db.connect(db_path)
    yield c
    c.close()
