"""Face detection + embedding via InsightFace (buffalo_l, ONNX Runtime, CPU-friendly)."""
import os

import numpy as np

_app = None


def get_engine():
    """Lazy-load the InsightFace model (downloads ~300MB to ~/.insightface on first run)."""
    global _app
    if _app is None:
        from insightface.app import FaceAnalysis
        # Only detection and recognition. The pack also ships landmark_3d_68,
        # landmark_2d_106 and genderage, which run on every face and cost about
        # 40% of the total; nothing here reads their output.
        _app = FaceAnalysis(
            name=os.environ.get("FACESCAN_MODEL", "buffalo_l"),
            allowed_modules=["detection", "recognition"],
            providers=["CPUExecutionProvider"],
        )
        det_size = int(os.environ.get("FACESCAN_DET_SIZE", "1024"))
        _app.prepare(ctx_id=0, det_size=(det_size, det_size))
    return _app


# Event photos are often 6000x4000. The detector works at FACESCAN_DET_SIZE
# internally and recognition crops are 112x112, so feeding it the full frame
# mostly buys decode/resize cost. Cap the long edge first.
MAX_EDGE = int(os.environ.get("FACESCAN_MAX_EDGE", "2560"))
QUERY_MAX_EDGE = int(os.environ.get("FACESCAN_QUERY_MAX_EDGE", "1600"))


def downscale(image_bgr: np.ndarray, max_edge: int = 0):
    """Shrink so the long edge is at most max_edge. Returns (image, scale).

    scale is what the returned coordinates must be divided by to map back to
    the original image.
    """
    import cv2
    max_edge = max_edge or MAX_EDGE
    h, w = image_bgr.shape[:2]
    scale = max_edge / max(h, w)
    if scale >= 1.0:
        return image_bgr, 1.0
    resized = cv2.resize(image_bgr, (round(w * scale), round(h * scale)),
                         interpolation=cv2.INTER_AREA)
    return resized, scale


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
