import numpy as np

from facescan.engine import cosine_search

from .conftest import unit


def test_cosine_search_empty_index():
    idx, scores = cosine_search(unit(0), np.zeros((0, 512), dtype=np.float32))
    assert idx.size == 0 and scores.size == 0


def test_cosine_search_sorted_desc_above_threshold():
    q = unit(1)
    embs = np.stack([unit(2), q, 0.6 * q + 0.8 * unit(3)]).astype(np.float32)
    embs /= np.linalg.norm(embs, axis=1, keepdims=True)

    idx, scores = cosine_search(q, embs, threshold=0.35)

    assert list(idx) == [1, 2]
    assert scores[0] > scores[1] >= 0.35


def test_cosine_search_threshold_excludes_everything():
    q = unit(4)
    embs = np.stack([unit(5), unit(6)]).astype(np.float32)
    idx, _ = cosine_search(q, embs, threshold=0.99)
    assert idx.size == 0
