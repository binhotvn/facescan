"""FaceScan web app: runners upload a selfie (or take one) and get their event photos.

Run:  uvicorn app:app --host 0.0.0.0 --port 8000
"""
import os
from pathlib import Path

import cv2
import numpy as np
from fastapi import FastAPI, File, UploadFile, HTTPException, Query
from fastapi.responses import HTMLResponse, FileResponse

from facescan import db
from facescan.engine import extract_faces
from facescan.search import search_embedding

PHOTOS_DIR = Path(os.environ.get("FACESCAN_PHOTOS", "photos")).resolve()
DEFAULT_THRESHOLD = float(os.environ.get("FACESCAN_THRESHOLD", "0.35"))

app = FastAPI(title="FaceScan")

INDEX_HTML = (Path(__file__).parent / "static" / "index.html").read_text()


@app.get("/", response_class=HTMLResponse)
def home():
    return INDEX_HTML


@app.get("/api/stats")
def api_stats():
    conn = db.connect()
    return db.stats(conn)


@app.post("/api/search")
async def api_search(
    file: UploadFile = File(...),
    threshold: float = Query(DEFAULT_THRESHOLD, ge=0.1, le=0.9),
):
    data = await file.read()
    arr = np.frombuffer(data, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise HTTPException(400, "Could not decode image.")
    faces = extract_faces(img)
    if not faces:
        raise HTTPException(422, "No face detected — try a clearer, front-facing photo.")
    face = max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
    results = search_embedding(face.normed_embedding, threshold)
    return {
        "matches": [
            {"url": f"/photo?path={r['path']}", "score": round(r["score"], 3),
             "bbox": [round(v, 1) for v in r["bbox"]]}
            for r in results
        ]
    }


@app.get("/photo")
def photo(path: str):
    p = Path(path).resolve()
    # Only serve files from inside the photos directory
    if not p.is_file() or not p.is_relative_to(PHOTOS_DIR):
        raise HTTPException(404, "Not found")
    return FileResponse(p)
