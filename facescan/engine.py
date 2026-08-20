"""Face detection + embedding via InsightFace (buffalo_l, ONNX Runtime, CPU-friendly)."""
import os

import numpy as np

_app = None


def get_engine():
    """Lazy-load the InsightFace model (downloads ~300MB to ~/.insightface on first run)."""
    global _app
    if _app is None:
        from insightface.app import FaceAnalysis
        _app = FaceAnalysis(
            name=os.environ.get("FACESCAN_MODEL", "buffalo_l"),
            providers=["CPUExecutionProvider"],
        )
        det_size = int(os.environ.get("FACESCAN_DET_SIZE", "1024"))
        _app.prepare(ctx_id=0, det_size=(det_size, det_size))
    return _app


def extract_faces(image_bgr: np.ndarray):
    """Return list of faces: each has .bbox, .det_score, .normed_embedding."""
    return get_engine().get(image_bgr)


def cosine_search(query_emb: np.ndarray, index_embs: np.ndarray, threshold: float = 0.35):
    """query_emb: (512,) normalized. index_embs: (N,512) normalized.
    Returns (indices, scores) above threshold, sorted by score desc."""
    if index_embs.shape[0] == 0:
        return np.array([], dtype=int), np.array([])
    q = query_emb / (np.linalg.norm(query_emb) + 1e-10)
    scores = index_embs @ q
    idx = np.where(scores >= threshold)[0]
    order = idx[np.argsort(-scores[idx])]
    return order, scores[order]
