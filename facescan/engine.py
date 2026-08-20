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


def detect_query_face(image_bgr: np.ndarray):
    """Find the main (largest) face in a query/selfie image, or None.

    The detector's anchors miss faces that fill the whole frame (tight
    selfies / face crops), so on a miss we retry with the image padded so
    the face occupies a smaller fraction of the canvas.
    """
    import cv2
    for pad_frac in (0.0, 0.5, 1.5):
        img = image_bgr
        if pad_frac:
            h, w = image_bgr.shape[:2]
            ph, pw = int(h * pad_frac), int(w * pad_frac)
            img = cv2.copyMakeBorder(image_bgr, ph, ph, pw, pw,
                                     cv2.BORDER_CONSTANT, value=(114, 114, 114))
        faces = extract_faces(img)
        if faces:
            return max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
    return None


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
