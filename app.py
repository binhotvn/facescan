"""FaceScan web app: runners upload a selfie (or take one) and get their event photos.

Run:  uvicorn app:app --host 0.0.0.0 --port 8000
"""
import hashlib
import logging
import os
import threading
import urllib.parse
from pathlib import Path

import cv2
import numpy as np
from fastapi import FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, HTMLResponse

from facescan import db
from facescan.engine import detect_query_face
from facescan.index import HAVE_FAISS, FaceIndex

logging.basicConfig(level=logging.INFO)

PHOTOS_DIR = Path(os.environ.get("FACESCAN_PHOTOS", "photos")).resolve()
THUMBS_DIR = Path(os.environ.get("FACESCAN_THUMBS", "data/thumbs")).resolve()
DEFAULT_THRESHOLD = float(os.environ.get("FACESCAN_THRESHOLD", "0.35"))
MAX_UPLOAD_BYTES = int(os.environ.get("FACESCAN_MAX_UPLOAD_MB", "15")) * 1024 * 1024
THUMB_SIZE = 480

app = FastAPI(title="FF Agency — FaceScan")
index = FaceIndex()
# InsightFace sessions are not thread-safe; serialize inference across requests
_infer_lock = threading.Lock()

# Serve the built Carbon/React frontend (frontend/ -> static/dist);
# fall back to the plain static page if it hasn't been built.
_STATIC = Path(__file__).parent / "static"
_DIST = _STATIC / "dist"


def _index_html() -> str:
    # read per request (it's <1KB): asset hashes change on every frontend build
    page = _DIST / "index.html"
    if not page.is_file():
        page = _STATIC / "index.html"
    return page.read_text()


@app.on_event("startup")
def _warmup():
    index.refresh(force=True)
    # Containers bake the model into the image (scripts/prefetch_model.py); loading
    # it at startup keeps the first search fast. Off by default for local dev/tests.
    if os.environ.get("FACESCAN_WARMUP", "0") == "1":
        try:
            from facescan.engine import get_engine
            get_engine()
            logging.getLogger("facescan").info("face model loaded")
        except Exception as e:  # noqa: BLE001 - never block startup on the model
            logging.getLogger("facescan").warning("model warmup failed: %s", e)


@app.get("/", response_class=HTMLResponse)
def home():
    return _index_html()


@app.get("/healthz")
def healthz():
    return {"ok": True, "faces_indexed": index.size, "faiss": HAVE_FAISS}


@app.get("/api/stats")
def api_stats():
    conn = db.connect()
    s = db.stats(conn)
    conn.close()
    return s


def _photo_urls(path: str) -> dict:
    q = urllib.parse.quote(path)
    return {"url": f"/photo?path={q}", "thumb": f"/photo?path={q}&thumb=1"}


@app.get("/api/photos")
def api_photos(
    limit: int = Query(120, ge=1, le=500),
    offset: int = Query(0, ge=0),
):
    """The whole gallery, newest first — what the app shows before any search."""
    conn = db.connect()
    rows = db.list_photos(conn, limit, offset)
    total = db.stats(conn)["photos"]
    conn.close()
    return {
        "total": total,
        "offset": offset,
        "limit": limit,
        "photos": [dict(_photo_urls(r["path"]), faces=r["n_faces"]) for r in rows],
    }


@app.post("/api/refresh")
def api_refresh():
    """Reload the index after a new ingest run (also happens automatically)."""
    index.refresh(force=True)
    return {"faces_indexed": index.size}


@app.post("/api/search")
def api_search(
    file: UploadFile = File(...),
    threshold: float = Query(DEFAULT_THRESHOLD, ge=0.1, le=0.9),
):
    data = file.file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "Image too large.")
    arr = np.frombuffer(data, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(400, "Could not decode image.")
    with _infer_lock:
        face = detect_query_face(img)
    if face is None:
        raise HTTPException(422, "No face detected — try a clearer, front-facing photo.")
    results = index.search(face.normed_embedding, threshold)
    return {
        "matches": [
            dict(
                _photo_urls(r["path"]),
                score=round(r["score"], 3),
                bbox=[round(v, 1) for v in r["bbox"]],
            )
            for r in results
        ]
    }


def _thumb_path(p: Path) -> Path:
    key = hashlib.sha1(f"{p}:{p.stat().st_mtime}".encode()).hexdigest()
    return THUMBS_DIR / f"{key}.jpg"


@app.get("/photo")
def photo(path: str, thumb: bool = False):
    p = Path(path).resolve()
    # Only serve files from inside the photos directory
    if not p.is_file() or not p.is_relative_to(PHOTOS_DIR):
        raise HTTPException(404, "Not found")
    if not thumb:
        return FileResponse(p)
    tp = _thumb_path(p)
    if not tp.is_file():
        img = cv2.imread(str(p))
        if img is None:
            raise HTTPException(404, "Not found")
        h, w = img.shape[:2]
        scale = THUMB_SIZE / max(h, w)
        if scale < 1:
            img = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
        THUMBS_DIR.mkdir(parents=True, exist_ok=True)
        cv2.imwrite(str(tp), img, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return FileResponse(tp, media_type="image/jpeg")


if (_DIST / "assets").is_dir():
    from fastapi.staticfiles import StaticFiles
    app.mount("/assets", StaticFiles(directory=_DIST / "assets"), name="assets")
