"""FaceScan web app: runners upload a selfie (or take one) and get their event photos.

Run:  uvicorn app:app --host 0.0.0.0 --port 8000
"""
import hashlib
import io
import logging
import os
import threading
import urllib.parse
import zipfile
from pathlib import Path

import cv2
import numpy as np
from fastapi import Body, FastAPI, File, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse

from facescan import db
from facescan.engine import detect_query_face
from facescan.index import HAVE_FAISS, FaceIndex

logging.basicConfig(level=logging.INFO)

PHOTOS_DIR = Path(os.environ.get("FACESCAN_PHOTOS", "photos")).resolve()
THUMBS_DIR = Path(os.environ.get("FACESCAN_THUMBS", "data/thumbs")).resolve()
DEFAULT_THRESHOLD = float(os.environ.get("FACESCAN_THRESHOLD", "0.35"))
MAX_UPLOAD_BYTES = int(os.environ.get("FACESCAN_MAX_UPLOAD_MB", "15")) * 1024 * 1024
# Long-edge sizes: sm feeds the gallery grid, md the full-screen viewer. Serving
# 5-10MB originals to phones on event wifi is what these exist to avoid.
PHOTO_SIZES = {"sm": 480, "md": 1600}
EVENT_NAME = os.environ.get("FACESCAN_EVENT_NAME", "Ảnh sự kiện FF Agency")
EVENT_DATE = os.environ.get("FACESCAN_EVENT_DATE", "")
MAX_ZIP_PHOTOS = 200

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
    return {**s, "event": {"name": EVENT_NAME, "date": EVENT_DATE}}


def _photo_urls(path: str) -> dict:
    q = urllib.parse.quote(path)
    return {
        "path": path,
        "url": f"/photo?path={q}",
        "thumb": f"/photo?path={q}&size=sm",
        "medium": f"/photo?path={q}&size=md",
        "download": f"/photo?path={q}&download=1",
    }


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
        "photos": [
            dict(_photo_urls(r["path"]), id=r["id"], w=r["w"], h=r["h"], faces=r["n_faces"])
            for r in rows
        ],
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
                id=r["id"],
                w=r["w"],
                h=r["h"],
                score=round(r["score"], 3),
                bbox=[round(v, 1) for v in r["bbox"]],
            )
            for r in results
        ]
    }


def _safe_photo(path: str) -> Path:
    """Resolve a caller-supplied path, refusing anything outside PHOTOS_DIR.

    Every route that takes a path from the client goes through here — it is the
    only thing standing between a query string and the rest of the filesystem.
    """
    p = Path(path).resolve()
    if not p.is_file() or not p.is_relative_to(PHOTOS_DIR):
        raise HTTPException(404, "Not found")
    return p


def _cache_path(p: Path, size: str) -> Path:
    key = hashlib.sha1(f"{p}:{p.stat().st_mtime}:{size}".encode()).hexdigest()
    return THUMBS_DIR / f"{key}.jpg"


def _resized(p: Path, size: str) -> Path:
    """Path to a cached long-edge-capped JPEG, rendering it on first request."""
    cached = _cache_path(p, size)
    if cached.is_file():
        return cached
    img = cv2.imread(str(p))
    if img is None:
        raise HTTPException(404, "Not found")
    h, w = img.shape[:2]
    scale = PHOTO_SIZES[size] / max(h, w)
    if scale < 1:
        img = cv2.resize(img, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    THUMBS_DIR.mkdir(parents=True, exist_ok=True)
    cv2.imwrite(str(cached), img, [cv2.IMWRITE_JPEG_QUALITY, 85])
    return cached


@app.get("/photo")
def photo(
    path: str,
    size: str = Query("full", pattern="^(sm|md|full)$"),
    thumb: bool = False,
    download: bool = False,
):
    p = _safe_photo(path)
    if thumb:  # pre-existing URLs from earlier clients
        size = "sm"
    if size == "full":
        return FileResponse(p, filename=p.name if download else None)
    return FileResponse(
        _resized(p, size),
        media_type="image/jpeg",
        filename=p.name if download else None,
    )


@app.post("/api/download-zip")
def api_download_zip(paths: list[str] = Body(..., embed=True)):
    """Bundle someone's matches into one .zip — the point of finding them."""
    if not paths:
        raise HTTPException(400, "No photos selected.")
    if len(paths) > MAX_ZIP_PHOTOS:
        raise HTTPException(413, f"Too many photos (max {MAX_ZIP_PHOTOS}).")
    files = [_safe_photo(p) for p in paths]  # validate all before streaming anything

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:  # JPEGs don't compress
        seen = {}
        for f in files:
            name = f.name
            if name in seen:  # same filename from different folders
                seen[name] += 1
                name = f"{f.stem}-{seen[name]}{f.suffix}"
            else:
                seen[name] = 0
            zf.write(f, arcname=name)
    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="anh-cua-toi.zip"'},
    )


if (_DIST / "assets").is_dir():
    from fastapi.staticfiles import StaticFiles
    app.mount("/assets", StaticFiles(directory=_DIST / "assets"), name="assets")


# Vite copies frontend/public/* (logo, favicons) to the root of dist. Registered
# last so it never shadows /api, /photo or /healthz.
@app.get("/{filename}")
def dist_root_file(filename: str):
    f = _DIST / filename
    if "/" in filename or not f.is_file():
        raise HTTPException(404, "Not found")
    return FileResponse(f)
