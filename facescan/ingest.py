"""Ingest event photos: detect faces, embed, store in SQLite.

Usage:
    python -m facescan.ingest photos/              # index a folder (recursive)
    python -m facescan.ingest photos/ --workers 4  # parallel (one model per worker)
    python -m facescan.ingest photos/ --force      # re-index everything
"""
import argparse
import multiprocessing as mp
import sys
from pathlib import Path

import cv2
import numpy as np
from tqdm import tqdm

from . import db

IMAGE_EXTS = {".jpg", ".jpeg", ".png", ".webp", ".bmp"}


def iter_images(root: Path):
    for p in sorted(root.rglob("*")):
        if p.suffix.lower() in IMAGE_EXTS and p.is_file():
            yield p


def _process_one(img_path_str: str):
    """Worker: read + detect + embed one photo. Returns a picklable dict or None."""
    from .engine import extract_faces  # model loads lazily, once per process
    img = cv2.imread(img_path_str)
    if img is None:
        return None
    h, w = img.shape[:2]
    faces = extract_faces(img)
    return {
        "path": img_path_str,
        "width": w,
        "height": h,
        "faces": [
            {
                "bbox": [float(v) for v in f.bbox],
                "det_score": float(f.det_score),
                "embedding": np.asarray(f.normed_embedding, dtype=np.float32),
            }
            for f in faces
        ],
    }


def _store(conn, result, mtime: float) -> int:
    photo_id = db.upsert_photo(conn, result["path"], mtime, result["width"], result["height"])
    for f in result["faces"]:
        db.add_face(conn, photo_id, f["bbox"], f["det_score"], f["embedding"])
    db.set_face_count(conn, photo_id, len(result["faces"]))
    conn.commit()
    return len(result["faces"])


def ingest(folder: Path, force: bool = False, db_path: Path = db.DB_PATH, workers: int = 1):
    conn = db.connect(db_path)
    todo = []
    skipped = 0
    for img_path in iter_images(folder):
        rel, mtime = str(img_path), img_path.stat().st_mtime
        if not force and db.photo_is_indexed(conn, rel, mtime):
            skipped += 1
        else:
            todo.append((rel, mtime))
    if not todo and skipped == 0:
        print(f"No images found in {folder}", file=sys.stderr)
        return

    indexed = failed = total_faces = 0
    mtimes = dict(todo)
    paths = [t[0] for t in todo]

    if workers > 1 and len(paths) > 1:
        # spawn (not fork): ONNX runtime sessions don't survive forking
        ctx = mp.get_context("spawn")
        with ctx.Pool(workers) as pool:
            it = pool.imap_unordered(_process_one, paths, chunksize=4)
            for result in tqdm(it, total=len(paths), desc="Indexing", unit="img"):
                if result is None:
                    failed += 1
                    continue
                total_faces += _store(conn, result, mtimes[result["path"]])
                indexed += 1
    else:
        for path in tqdm(paths, desc="Indexing", unit="img"):
            result = _process_one(path)
            if result is None:
                tqdm.write(f"  ! unreadable: {path}")
                failed += 1
                continue
            total_faces += _store(conn, result, mtimes[path])
            indexed += 1

    s = db.stats(conn)
    print(f"\nDone. Indexed {indexed} new photos ({total_faces} faces), "
          f"skipped {skipped} unchanged, {failed} failed.")
    print(f"Database now holds {s['photos']} photos / {s['faces']} faces.")


def main():
    ap = argparse.ArgumentParser(description="Index event photos for face search.")
    ap.add_argument("folder", type=Path, help="Folder of event photos (recursive)")
    ap.add_argument("--force", action="store_true", help="Re-index even if unchanged")
    ap.add_argument("--workers", type=int, default=1,
                    help="Parallel worker processes (each loads its own model, ~1GB RAM each)")
    ap.add_argument("--db", type=Path, default=db.DB_PATH, help="SQLite database path")
    args = ap.parse_args()
    ingest(args.folder, force=args.force, db_path=args.db, workers=args.workers)


if __name__ == "__main__":
    main()
